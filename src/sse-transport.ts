import { McpDiceServer } from './mcp-server';

export class SSEMcpTransport {
  private mcpServer: McpDiceServer;
  private encoder = new TextEncoder();

  constructor() {
    this.mcpServer = new McpDiceServer();
  }

  async handleSSEConnection(request: Request): Promise<Response> {
    console.log('=== SSE CONNECTION ESTABLISHED ===');
    
    const stream = new ReadableStream({
      start: async (controller) => {
        // Send initial connection message
        controller.enqueue(this.encoder.encode(': SSE MCP connection established\n\n'));
        
        // Handle incoming messages from the client
        if (request.body) {
          await this.handleIncomingMessages(request.body, controller);
        }
        
        // Set up heartbeat
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(this.encoder.encode(': heartbeat\n\n'));
          } catch (error) {
            console.log('SSE heartbeat failed, client disconnected');
            clearInterval(heartbeat);
          }
        }, 30000);
        
        // Handle client disconnect
        request.signal?.addEventListener('abort', () => {
          console.log('SSE client disconnected');
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch (error) {
            // Controller already closed
          }
        });
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      }
    });
  }

  private async handleIncomingMessages(
    body: ReadableStream<Uint8Array>, 
    controller: ReadableStreamDefaultController
  ) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const messageData = line.substring(6);
              if (messageData.trim()) {
                const message = JSON.parse(messageData);
                await this.processMessage(message, controller);
              }
            } catch (error) {
              console.error('Error processing SSE message:', error);
              this.sendError(controller, null, -32700, 'Parse error');
            }
          }
        }
      }
    } catch (error) {
      console.log('SSE stream ended:', error);
    }
  }

  private async processMessage(
    message: any, 
    controller: ReadableStreamDefaultController
  ) {
    try {
      const response = await this.mcpServer.handleRequest(message);
      
      if (response !== null) {
        this.sendMessage(controller, response);
      }
    } catch (error: any) {
      console.error('Error processing MCP message:', error);
      this.sendError(controller, message.id, -32603, 'Internal error');
    }
  }

  private sendMessage(controller: ReadableStreamDefaultController, message: any) {
    try {
      const data = `data: ${JSON.stringify(message)}\n\n`;
      controller.enqueue(this.encoder.encode(data));
    } catch (error) {
      console.error('Error sending SSE message:', error);
    }
  }

  private sendError(
    controller: ReadableStreamDefaultController, 
    id: any, 
    code: number, 
    message: string
  ) {
    const errorResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message }
    };
    this.sendMessage(controller, errorResponse);
  }

  // Handle legacy POST-based SSE (for compatibility with your existing app)
  async handleSSEMessage(request: Request): Promise<Response> {
    console.log('=== SSE POST MESSAGE ===');
    
    try {
      const message = await request.json();
      const response = await this.mcpServer.handleRequest(message);
      
      if (response === null) {
        return new Response('', {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
          }
        });
      }

      return new Response(JSON.stringify(response), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    } catch (error: any) {
      const errorResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${error.message}`
        }
      };

      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }
  }
}