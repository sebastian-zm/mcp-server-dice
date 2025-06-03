import { Env } from './types';
import { McpDiceServer } from './mcp-server';
import { getCorsHeaders, getBaseUrl } from './utils';
import { SQLiteDurableObject } from './sqlite-durable-object';

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

    // SSE MCP endpoint using SQLite Durable Object
    if (pathname.startsWith('/sse')) {
      console.log(`[SSE] Request received: ${request.method} ${pathname}`);
      console.log(`[SSE] Query params:`, Object.fromEntries(url.searchParams));
      
      // Check if SQLite DO is configured
      if (!env.SQLITE_DO || !env.DB) {
        console.error('[SSE] SQLite DO not configured. env.SQLITE_DO:', !!env.SQLITE_DO, 'env.DB:', !!env.DB);
        return new Response(JSON.stringify({
          error: "SQLite Durable Object not configured. Please set up D1 database."
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...getCorsHeaders()
          }
        });
      }
      
      // Get or create a unique session ID
      const sessionId = url.searchParams.get('sessionId') || crypto.randomUUID();
      console.log(`[SSE] Session ID: ${sessionId}`);
      
      // Get the Durable Object instance
      const id = env.SQLITE_DO.idFromName(sessionId);
      const durableObject = env.SQLITE_DO.get(id);
      console.log(`[SSE] Got Durable Object instance for session: ${sessionId}`);
      
      // Route to the appropriate Durable Object endpoint
      const subPath = pathname.substring(4); // Remove '/sse' prefix
      const newUrl = new URL(request.url);
      
      // If no subpath, this is a standard SSE connection
      if (!subPath || subPath === '/') {
        newUrl.pathname = '/stream';
        console.log(`[SSE] Standard SSE connection, forwarding to /stream`);
      } else {
        newUrl.pathname = subPath;
        console.log(`[SSE] Forwarding to DO path: ${newUrl.pathname}`);
      }
      
      // Forward the request to the Durable Object
      return durableObject.fetch(newUrl, request);
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
            description: "MCP over Server-Sent Events (polling-based)",
            endpoints: {
              send: `${baseUrl}/sse/send?sessionId=YOUR_SESSION_ID`,
              events: `${baseUrl}/sse/events?sessionId=YOUR_SESSION_ID&lastEventId=0`,
              clear: `${baseUrl}/sse/clear?sessionId=YOUR_SESSION_ID`
            },
            method_send: "POST",
            method_events: "GET (poll for new events)",
            method_clear: "POST (clear session)",
            polling_interval: "Recommended: 1-5 seconds",
            session_id: "Use the same sessionId for all related requests"
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

// Export Durable Object class
export { SQLiteDurableObject };
