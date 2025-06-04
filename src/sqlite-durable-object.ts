import { Env } from './types';
import { McpDiceServer } from './mcp-server';
import { getCorsHeaders } from './utils';

export class SQLiteDurableObject {
  private state: DurableObjectState;
  private mcpServer: McpDiceServer;
  private db: D1Database;
  private initialized: boolean = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.mcpServer = new McpDiceServer();
    this.db = env.DB; // Assumes D1 database binding
  }

  private async initialize() {
    if (this.initialized) return;
    
    console.log('[DO] Initializing SQLite Durable Object');
    
    try {
      // Create tables if they don't exist
      console.log('[DO] Creating messages table...');
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      console.log('[DO] Creating messages timestamp index...');
      await this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp 
        ON messages(timestamp)
      `).run();

      console.log('[DO] Creating metadata table...');
      await this.db.prepare(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `).run();

      // Initialize last event ID if not exists
      console.log('[DO] Checking for existing lastEventId...');
      const lastEventId = await this.db.prepare(
        `SELECT value FROM metadata WHERE key = 'lastEventId'`
      ).first();
      
      if (!lastEventId) {
        console.log('[DO] Initializing lastEventId to 0');
        await this.db.prepare(
          `INSERT INTO metadata (key, value) VALUES ('lastEventId', '0')`
        ).run();
      } else {
        console.log(`[DO] Found existing lastEventId: ${lastEventId.value}`);
      }

      this.initialized = true;
      console.log('[DO] Initialization complete');
      
    } catch (error) {
      console.error('[DO] Initialization error:', error);
      throw error;
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();
    
    const url = new URL(request.url);
    const pathname = url.pathname;
    console.log(`[DO] Handling request: ${request.method} ${pathname}`);
    console.log(`[DO] Headers:`, Object.fromEntries(request.headers));

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      console.log('[DO] Handling OPTIONS preflight request');
      return new Response(null, {
        status: 200,
        headers: getCorsHeaders()
      });
    }

    // Handle POST to /stream endpoint (Claude Code sends messages here)
    if (pathname === '/stream' && request.method === 'POST') {
      console.log('[DO] Processing message via /stream POST');
      try {
        const message = await request.json();
        console.log('[DO] Received message:', JSON.stringify(message, null, 2));
        
        const response = await this.mcpServer.handleRequest(message);
        console.log('[DO] MCP response:', response ? 'Message generated' : 'No response (notification)');
        
        if (response !== null) {
          // Get and increment last event ID
          console.log('[DO] Incrementing event ID...');
          const result = await this.db.prepare(
            `UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) 
             WHERE key = 'lastEventId' 
             RETURNING value`
          ).first();
          
          const eventId = result?.value || '1';
          console.log(`[DO] New event ID: ${eventId}`);
          
          // Store the message
          console.log('[DO] Storing message in database...');
          await this.db.prepare(
            `INSERT INTO messages (id, message, timestamp) VALUES (?, ?, ?)`
          ).bind(eventId, JSON.stringify(response), Date.now()).run();
          console.log('[DO] Message stored successfully');
          
          // Clean up old messages
          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
          await this.db.prepare(`
            DELETE FROM messages 
            WHERE timestamp < ? 
            AND id NOT IN (
              SELECT id FROM messages 
              ORDER BY id DESC 
              LIMIT 100
            )
          `).bind(fiveMinutesAgo).run();
        }
        
        // Return empty response for POST
        return new Response('', {
          status: 204,
          headers: getCorsHeaders()
        });
        
      } catch (error: any) {
        console.error('[DO] Error processing /stream POST:', error);
        return new Response(JSON.stringify({
          error: error.message
        }), {
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            ...getCorsHeaders()
          }
        });
      }
    }
    
    // Standard SSE stream endpoint for Claude Code
    if (pathname === '/stream' && request.method === 'GET') {
      console.log('[DO] Processing SSE stream connection');
      
      const encoder = new TextEncoder();
      let intervalId: number | null = null;
      const db = this.db; // Capture db reference for closure
      
      const stream = new ReadableStream({
        async start(controller) {
          // Send initial connection message
          controller.enqueue(encoder.encode(': Connected to MCP Dice Server\n\n'));
          
          let lastEventId = '0';
          
          // Poll for new messages every second
          intervalId = setInterval(async () => {
            try {
              const messages = await db.prepare(`
                SELECT id, message, timestamp 
                FROM messages 
                WHERE CAST(id AS INTEGER) > CAST(? AS INTEGER)
                ORDER BY id ASC
                LIMIT 10
              `).bind(lastEventId).all();
              
              if (messages.results && messages.results.length > 0) {
                for (const event of messages.results) {
                  const data = `id: ${event.id}\ndata: ${event.message}\n\n`;
                  controller.enqueue(encoder.encode(data));
                  lastEventId = event.id;
                  console.log(`[DO] Sent event ${event.id} via SSE stream`);
                }
              }
            } catch (error) {
              console.error('[DO] Error in SSE stream:', error);
              controller.error(error);
              if (intervalId) clearInterval(intervalId);
            }
          }, 1000) as unknown as number;
        },
        
        cancel() {
          console.log('[DO] SSE stream cancelled');
          if (intervalId) clearInterval(intervalId);
        }
      });
      
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...getCorsHeaders()
        }
      });
    }

    if (pathname === '/send' && request.method === 'POST') {
      console.log('[DO] Processing /send request');
      try {
        const message = await request.json();
        console.log('[DO] Received message:', JSON.stringify(message, null, 2));
        
        const response = await this.mcpServer.handleRequest(message);
        console.log('[DO] MCP response:', response ? 'Message generated' : 'No response (notification)');
        
        if (response !== null) {
          // Get and increment last event ID
          console.log('[DO] Incrementing event ID...');
          const result = await this.db.prepare(
            `UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) 
             WHERE key = 'lastEventId' 
             RETURNING value`
          ).first();
          
          const eventId = result?.value || '1';
          console.log(`[DO] New event ID: ${eventId}`);
          
          // Store the message
          console.log('[DO] Storing message in database...');
          await this.db.prepare(
            `INSERT INTO messages (id, message, timestamp) VALUES (?, ?, ?)`
          ).bind(eventId, JSON.stringify(response), Date.now()).run();
          console.log('[DO] Message stored successfully');
          
          // Clean up old messages (keep last 100 or last 5 minutes)
          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
          console.log('[DO] Cleaning up old messages...');
          const cleanupResult = await this.db.prepare(`
            DELETE FROM messages 
            WHERE timestamp < ? 
            AND id NOT IN (
              SELECT id FROM messages 
              ORDER BY id DESC 
              LIMIT 100
            )
          `).bind(fiveMinutesAgo).run();
          console.log(`[DO] Cleaned up ${cleanupResult.meta.changes} old messages`);
        }
        
        return new Response(JSON.stringify({ success: true }), {
          headers: { 
            'Content-Type': 'application/json',
            ...getCorsHeaders()
          }
        });
        
      } catch (error: any) {
        console.error('[DO] Error processing /send:', error);
        return new Response(JSON.stringify({
          error: error.message
        }), {
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            ...getCorsHeaders()
          }
        });
      }
    }

    if (pathname === '/events' && request.method === 'GET') {
      const lastEventId = url.searchParams.get('lastEventId') || '0';
      console.log(`[DO] Processing /events request, lastEventId: ${lastEventId}`);
      
      // Get new messages since lastEventId
      console.log('[DO] Querying for new messages...');
      const messages = await this.db.prepare(`
        SELECT id, message, timestamp 
        FROM messages 
        WHERE CAST(id AS INTEGER) > CAST(? AS INTEGER)
        ORDER BY id ASC
        LIMIT 50
      `).bind(lastEventId).all();
      
      console.log(`[DO] Found ${messages.results?.length || 0} new messages`);
      
      if (!messages.results || messages.results.length === 0) {
        // Get current last event ID for client
        const currentLastId = await this.db.prepare(
          `SELECT value FROM metadata WHERE key = 'lastEventId'`
        ).first();
        
        console.log(`[DO] No new messages, returning 204. Current lastEventId: ${currentLastId?.value || '0'}`);
        
        return new Response('', {
          status: 204,
          headers: {
            'X-Last-Event-ID': currentLastId?.value || '0',
            'Cache-Control': 'no-cache',
            ...getCorsHeaders()
          }
        });
      }
      
      // Format messages as SSE
      console.log('[DO] Formatting messages as SSE...');
      const sseData = messages.results.map(event => {
        console.log(`[DO] Formatting event ${event.id}`);
        return `id: ${event.id}\ndata: ${event.message}\n\n`;
      }).join('');
      
      const lastId = messages.results[messages.results.length - 1].id;
      console.log(`[DO] Returning ${messages.results.length} events, lastId: ${lastId}`);
      
      return new Response(sseData, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Last-Event-ID': String(lastId),
          ...getCorsHeaders()
        }
      });
    }

    if (pathname === '/clear' && request.method === 'POST') {
      console.log('[DO] Processing /clear request');
      
      // Clear all messages
      const deleteResult = await this.db.prepare(`DELETE FROM messages`).run();
      console.log(`[DO] Deleted ${deleteResult.meta.changes} messages`);
      
      await this.db.prepare(
        `UPDATE metadata SET value = '0' WHERE key = 'lastEventId'`
      ).run();
      console.log('[DO] Reset lastEventId to 0');
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 
          'Content-Type': 'application/json',
          ...getCorsHeaders()
        }
      });
    }

    if (pathname === '/stats' && request.method === 'GET') {
      // Get statistics about the database
      const count = await this.db.prepare(
        `SELECT COUNT(*) as count FROM messages`
      ).first();
      
      const oldest = await this.db.prepare(
        `SELECT MIN(timestamp) as oldest FROM messages`
      ).first();
      
      const newest = await this.db.prepare(
        `SELECT MAX(timestamp) as newest FROM messages`
      ).first();
      
      return new Response(JSON.stringify({
        messageCount: count?.count || 0,
        oldestMessage: oldest?.oldest || null,
        newestMessage: newest?.newest || null
      }), {
        headers: { 
          'Content-Type': 'application/json',
          ...getCorsHeaders()
        }
      });
    }

    console.log(`[DO] Unknown endpoint: ${pathname}`);
    return new Response('Not Found', { status: 404 });
  }
}