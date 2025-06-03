import { Env } from './types';
import { McpDiceServer } from './mcp-server';

export class SSEConnectionDurableObject {
  private state: DurableObjectState;
  private mcpServer: McpDiceServer;
  private messages: Array<{ id: string; message: any; timestamp: number }> = [];
  private lastEventId: number = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.mcpServer = new McpDiceServer();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Initialize storage if needed
    if (!this.messages) {
      this.messages = await this.state.storage.get('messages') || [];
    }

    if (pathname === '/send' && request.method === 'POST') {
      // Handle incoming MCP message
      try {
        const message = await request.json();
        const response = await this.mcpServer.handleRequest(message);
        
        if (response !== null) {
          // Store the response for SSE delivery
          const eventId = ++this.lastEventId;
          const event = {
            id: eventId.toString(),
            message: response,
            timestamp: Date.now()
          };
          
          this.messages.push(event);
          
          // Keep only last 100 messages (or last 5 minutes)
          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
          this.messages = this.messages.filter(m => 
            m.timestamp > fiveMinutesAgo
          ).slice(-100);
          
          // Persist to storage
          await this.state.storage.put('messages', this.messages);
          await this.state.storage.put('lastEventId', this.lastEventId);
        }
        
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
        
      } catch (error: any) {
        return new Response(JSON.stringify({
          error: error.message
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (pathname === '/events' && request.method === 'GET') {
      // Handle SSE connection (polling-based for free tier)
      const lastEventId = url.searchParams.get('lastEventId') || '0';
      const lastId = parseInt(lastEventId, 10);
      
      // Get new messages since lastEventId
      const newMessages = this.messages.filter(m => 
        parseInt(m.id, 10) > lastId
      );
      
      if (newMessages.length === 0) {
        // No new messages, return empty response for client to poll again
        return new Response('', {
          status: 204,
          headers: {
            'X-Last-Event-ID': this.lastEventId.toString(),
            'Cache-Control': 'no-cache'
          }
        });
      }
      
      // Format messages as SSE
      const sseData = newMessages.map(event => 
        `id: ${event.id}\ndata: ${JSON.stringify(event.message)}\n\n`
      ).join('');
      
      return new Response(sseData, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Last-Event-ID': newMessages[newMessages.length - 1].id
        }
      });
    }

    if (pathname === '/clear' && request.method === 'POST') {
      // Clear messages (useful for cleanup)
      this.messages = [];
      this.lastEventId = 0;
      await this.state.storage.put('messages', this.messages);
      await this.state.storage.put('lastEventId', this.lastEventId);
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}