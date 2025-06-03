import { Env } from './types';
import { McpDiceServer } from './mcp-server';
import { SSEMcpTransport } from './sse-transport';
import { getCorsHeaders, getBaseUrl } from './utils';

// Main Cloudflare Worker
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const baseUrl = getBaseUrl(request);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: getCorsHeaders()
      });
    }

    // Main MCP endpoint (HTTP transport)
    if (pathname === '/mcp' && request.method === 'POST') {
      try {
        const mcpServer = new McpDiceServer();
        const message = await request.json();
        
        const response = await mcpServer.handleRequest(message);
        
        // Handle notifications (no response)
        if (response === null) {
          return new Response('', {
            status: 204,
            headers: getCorsHeaders()
          });
        }

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders()
          }
        });

      } catch (error: any) {
        console.error('MCP endpoint error:', error);
        
        const errorResponse = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error",
            data: { details: error.message }
          }
        };

        return new Response(JSON.stringify(errorResponse), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders()
          }
        });
      }
    }

    // SSE MCP endpoint (for legacy applications)
    if (pathname === '/sse') {
      const sseTransport = new SSEMcpTransport();
      
      if (request.method === 'GET') {
        // Establish SSE connection
        return sseTransport.handleSSEConnection(request);
      } else if (request.method === 'POST') {
        // Handle legacy POST-based messages
        return sseTransport.handleSSEMessage(request);
      }
    }

    // Health check endpoint
    if (pathname === '/health') {
      return new Response(JSON.stringify({
        status: "healthy",
        timestamp: new Date().toISOString(),
        version: "2.0.0",
        mcp_protocol: "2024-11-05",
        transports: ["http", "sse"]
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders()
        }
      });
    }

    // Server info endpoint
    if (pathname === '/' || pathname === '/info') {
      return new Response(JSON.stringify({
        name: "Dice Rolling MCP Server",
        version: "2.0.0",
        description: "A Model Context Protocol server for rolling dice with advanced notation support",
        protocol: "MCP 2024-11-05",
        transports: ["http", "sse"],
        endpoints: {
          mcp: `${baseUrl}/mcp`,
          sse: `${baseUrl}/sse`,
          health: `${baseUrl}/health`,
          info: `${baseUrl}/`
        },
        capabilities: {
          tools: ["roll"],
          resources: false,
          prompts: false,
          logging: true
        },
        tools: [
          {
            name: "roll",
            description: "Roll dice using advanced notation",
            examples: [
              "2d6 - Roll two six-sided dice",
              "4d6k3 - Roll 4d6, keep highest 3",
              "d20+5 - Roll d20 and add 5",
              "3d6! - Roll 3d6 with exploding dice",
              "(2d6+3)*2 - Complex mathematical expression"
            ]
          }
        ],
        usage: {
          http_transport: {
            description: "Standard MCP over HTTP",
            endpoint: `${baseUrl}/mcp`,
            method: "POST",
            content_type: "application/json"
          },
          sse_transport: {
            description: "MCP over Server-Sent Events",
            endpoint: `${baseUrl}/sse`,
            method_connect: "GET",
            method_message: "POST (legacy) or data: events",
            content_type: "text/event-stream"
          }
        },
        dice_notation: {
          basic: "NdX (e.g., 2d6, d20, d%)",
          fudge: "NdF (FATE dice: -1, 0, +1)",
          keep_drop: "NdXkY (keep highest Y), NdXdY (drop lowest Y)",
          exploding: "NdX! (explode on max), NdXeY (explode on Y+)",
          reroll: "NdXrY (reroll if result ≤ Y)",
          math: "Full mathematical expressions with +, -, *, parentheses",
          limits: {
            dice_count: "1-1,000",
            dice_sides: "1-10,000",
            numbers: "Up to 1,000,000"
          }
        }
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders()
        }
      });
    }

    // 404 for everything else
    return new Response('Not Found', { 
      status: 404,
      headers: getCorsHeaders()
    });
  },
};
