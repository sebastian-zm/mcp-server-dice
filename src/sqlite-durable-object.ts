import { Env } from './types';
import { McpDiceServer } from './mcp-server';

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
    
    // Create tables if they don't exist
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    await this.db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp 
      ON messages(timestamp)
    `).run();

    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `).run();

    // Initialize last event ID if not exists
    const lastEventId = await this.db.prepare(
      `SELECT value FROM metadata WHERE key = 'lastEventId'`
    ).first();
    
    if (!lastEventId) {
      await this.db.prepare(
        `INSERT INTO metadata (key, value) VALUES ('lastEventId', '0')`
      ).run();
    }

    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();
    
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/send' && request.method === 'POST') {
      try {
        const message = await request.json();
        const response = await this.mcpServer.handleRequest(message);
        
        if (response !== null) {
          // Get and increment last event ID
          const result = await this.db.prepare(
            `UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) 
             WHERE key = 'lastEventId' 
             RETURNING value`
          ).first();
          
          const eventId = result?.value || '1';
          
          // Store the message
          await this.db.prepare(
            `INSERT INTO messages (id, message, timestamp) VALUES (?, ?, ?)`
          ).bind(eventId, JSON.stringify(response), Date.now()).run();
          
          // Clean up old messages (keep last 100 or last 5 minutes)
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
      const lastEventId = url.searchParams.get('lastEventId') || '0';
      
      // Get new messages since lastEventId
      const messages = await this.db.prepare(`
        SELECT id, message, timestamp 
        FROM messages 
        WHERE CAST(id AS INTEGER) > CAST(? AS INTEGER)
        ORDER BY id ASC
        LIMIT 50
      `).bind(lastEventId).all();
      
      if (!messages.results || messages.results.length === 0) {
        // Get current last event ID for client
        const currentLastId = await this.db.prepare(
          `SELECT value FROM metadata WHERE key = 'lastEventId'`
        ).first();
        
        return new Response('', {
          status: 204,
          headers: {
            'X-Last-Event-ID': currentLastId?.value || '0',
            'Cache-Control': 'no-cache'
          }
        });
      }
      
      // Format messages as SSE
      const sseData = messages.results.map(event => 
        `id: ${event.id}\ndata: ${event.message}\n\n`
      ).join('');
      
      const lastId = messages.results[messages.results.length - 1].id;
      
      return new Response(sseData, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Last-Event-ID': String(lastId)
        }
      });
    }

    if (pathname === '/clear' && request.method === 'POST') {
      // Clear all messages
      await this.db.prepare(`DELETE FROM messages`).run();
      await this.db.prepare(
        `UPDATE metadata SET value = '0' WHERE key = 'lastEventId'`
      ).run();
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
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
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}