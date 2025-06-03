import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Type definitions
type Env = {
  DICE_KV?: KVNamespace; // Optional, not used without persistence
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

// Simple stateless MCP server
class DiceServer {
  private parser: DiceParser;
  private tools = new Map<string, { handler: Function; description: string; inputSchema: any }>();

  constructor() {
    this.parser = new DiceParser();
    this.setupTools();
  }

  private setupTools() {
    // Roll dice tool (no history saving)
    const rollHandler = async ({ expression, description }: any) => {
      try {
        const result = this.parser.parse(expression);

        let output = `🎲 **${result.expression}**`;
        if (description) {
          output += ` *(${description})*`;
        }
        output += `\n\n${result.breakdown}\n\n**Result: ${result.total}**`;

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `❌ **Invalid dice expression**: ${error.message}\n\n**Examples:**\n• Basic: \`2d6\`, \`d20\`, \`d%\`\n• Advanced: \`4d6k3\`, \`3d6!\`, \`2*(d4+d6)\`\n• Complex: \`d20+5\`, \`(2d6+3)*2+1d4\``
            }
          ],
        };
      }
    };

    this.tools.set("roll", {
      handler: rollHandler,
      description: "Roll dice using advanced notation. Supports complex expressions, keep/drop, exploding dice, and more.",
      inputSchema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: `Dice expression to evaluate. Supports:
• Basic: 2d6, d20, d%
• Keep/Drop: 4d6k3 (keep highest 3), 5d8d2 (drop lowest 2)
• Exploding: 3d6! (explode on max), 2d10e8 (explode on 8+)
• Reroll: 4d6r1 (reroll 1s)
• Fudge: 4dF (FATE dice)
• Math: d20+5, 2d6+1d4-2
• Multiplication: 3*(2d6+1), 2×(d4+d6)
• Complex: (2d6+3)*2+1d4-3d8k2`
          },
          description: {
            type: "string",
            description: "Optional description of what this roll is for"
          }
        },
        required: ["expression"]
      }
    });
  }

  async handleMessage(message: any) {
    let response;
    
    console.log('=== HANDLING MESSAGE ===', message);
    
    switch (message.method) {
      case 'initialize':
        response = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
              logging: {}
            },
            serverInfo: {
              name: "Dice Rolling Server",
              version: "2.0.0"
            }
          }
        };
        break;
        
      case 'notifications/initialized':
        // This is a notification, so no response needed
        console.log('Received initialized notification');
        return null;
        
      case 'tools/list':
        const tools = [];
        for (const [name, tool] of this.tools.entries()) {
          tools.push({
            name: name,
            description: tool.description,
            inputSchema: tool.inputSchema
          });
        }
        response = {
          jsonrpc: "2.0",
          id: message.id,
          result: { tools }
        };
        break;
        
      case 'tools/call':
        const toolName = message.params.name;
        const args = message.params.arguments || {};
        
        if (this.tools.has(toolName)) {
          const tool = this.tools.get(toolName)!;
          try {
            const result = await tool.handler(args);
            response = {
              jsonrpc: "2.0",
              id: message.id,
              result: result
            };
          } catch (error: any) {
            response = {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32603,
                message: error.message
              }
            };
          }
        } else {
          response = {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32601,
              message: `Tool not found: ${toolName}`
            }
          };
        }
        break;
        
      default:
        response = {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Method not found: ${message.method}`
          }
        };
    }

    console.log('=== SENDING RESPONSE ===', response);
    return response;
  }
}

// Dice notation parser (same as before)
class DiceParser {
  private position = 0;
  private input = "";
  private readonly MAX_NUMBER = 1000000;
  private readonly MAX_DICE_COUNT = 1000;
  private readonly MAX_DICE_SIDES = 10000;

  parse(expression: string): DiceResult {
    this.input = expression.toLowerCase().replace(/\s+/g, '');
    this.position = 0;

    try {
      const result = this.parseExpression();
      if (this.position < this.input.length) {
        throw new Error(`Unexpected character at position ${this.position}: '${this.input[this.position]}'`);
      }
      return result;
    } catch (error: any) {
      throw new Error(`Parse error: ${error.message}`);
    }
  }

  private parseExpression(): DiceResult {
    let left = this.parseTerm();

    while (this.position < this.input.length) {
      const operator = this.input[this.position];
      if (operator === '+' || operator === '-') {
        this.position++;
        const right = this.parseTerm();
        left = this.combineResults(left, right, operator);
      } else {
        break;
      }
    }

    return left;
  }

  private parseTerm(): DiceResult {
    let left = this.parseFactor();

    while (this.position < this.input.length) {
      const char = this.input[this.position];
      if (char === '*' || char === '×' || char === '·') {
        this.position++;
        const right = this.parseFactor();
        left = this.multiplyResults(left, right);
      } else {
        break;
      }
    }

    return left;
  }

  private parseFactor(): DiceResult {
    if (this.peek() === '(') {
      this.position++; // consume '('
      const result = this.parseExpression();
      if (this.peek() !== ')') {
        throw new Error("Missing closing parenthesis");
      }
      this.position++; // consume ')'
      return result;
    }

    return this.parseDiceOrNumber();
  }

  private parseDiceOrNumber(): DiceResult {
    const start = this.position;

    // Handle negative numbers
    let negative = false;
    if (this.peek() === '-') {
      negative = true;
      this.position++;
    }

    // Parse number
    let count = this.parseNumber();

    // Check for dice notation
    if (this.peek() === 'd') {
      this.position++; // consume 'd'

      // Handle percentile dice
      if (this.peek() === '%') {
        this.position++;
        return this.rollDice(count || 1, 100, { negative });
      }

      // Handle fudge dice
      if (this.peek() === 'f') {
        this.position++;
        return this.rollFudgeDice(count || 1, { negative });
      }

      // Parse sides
      const sides = this.parseNumber();
      if (!sides) {
        throw new Error("Missing number of sides after 'd'");
      }

      // Parse modifiers (keep, drop, explode)
      const modifiers = this.parseModifiers();

      return this.rollDice(count || 1, sides, { ...modifiers, negative });
    }

    // Just a number
    if (count === null) {
      throw new Error(`Expected number or dice notation at position ${start}`);
    }

    return {
      total: negative ? -count : count,
      rolls: [],
      expression: negative ? `-${count}` : count.toString(),
      breakdown: negative ? `-${count}` : count.toString()
    };
  }

  private parseModifiers(): DiceModifiers {
    const modifiers: DiceModifiers = {};

    while (this.position < this.input.length) {
      const char = this.peek();

      if (char === 'k') {
        this.position++;
        modifiers.keep = this.parseNumber();
        if (!modifiers.keep) throw new Error("Missing number after 'k'");
      } else if (char === 'd' && this.peek(1) !== undefined && /\d/.test(this.peek(1))) {
        this.position++;
        modifiers.drop = this.parseNumber();
        if (!modifiers.drop) throw new Error("Missing number after 'd'");
      } else if (char === '!' || char === 'e') {
        this.position++;
        modifiers.explode = true;
        if (/\d/.test(this.peek())) {
          modifiers.explodeOn = this.parseNumber();
        }
      } else if (char === 'r') {
        this.position++;
        modifiers.reroll = this.parseNumber();
        if (!modifiers.reroll) throw new Error("Missing number after 'r'");
      } else {
        break;
      }
    }

    return modifiers;
  }

  private parseNumber(): number | null {
    const start = this.position;
    while (this.position < this.input.length && /\d/.test(this.input[this.position])) {
      this.position++;
    }

    if (start === this.position) return null;
    const num = parseInt(this.input.slice(start, this.position));
    
    if (num > this.MAX_NUMBER) {
      throw new Error(`Number too large (max ${this.MAX_NUMBER.toLocaleString()})`);
    }
    
    return num;
  }

  private peek(offset = 0): string {
    return this.input[this.position + offset] || '';
  }

  private rollDice(count: number, sides: number, options: DiceModifiers & { negative?: boolean } = {}): DiceResult {
    if (count <= 0 || count > this.MAX_DICE_COUNT) {
      throw new Error(`Dice count must be between 1 and ${this.MAX_DICE_COUNT}`);
    }
    if (sides <= 0 || sides > this.MAX_DICE_SIDES) {
      throw new Error(`Dice sides must be between 1 and ${this.MAX_DICE_SIDES}`);
    }
    
    if (count * sides > this.MAX_NUMBER) {
      throw new Error("Total possible outcomes too large");
    }

    const rolls: number[] = [];
    const allRolls: number[] = [];

    for (let i = 0; i < count; i++) {
      let roll = Math.floor(Math.random() * sides) + 1;
      rolls.push(roll);
      allRolls.push(roll);

      if (options.explode) {
        const explodeThreshold = options.explodeOn || sides;
        let explodeCount = 0;
        while (roll >= explodeThreshold && explodeCount < 100) {
          roll = Math.floor(Math.random() * sides) + 1;
          allRolls.push(roll);
          rolls[i] += roll;
          explodeCount++;
        }
      }

      if (options.reroll && rolls[i] <= options.reroll) {
        rolls[i] = Math.floor(Math.random() * sides) + 1;
      }
    }

    let finalRolls = [...rolls];
    if (options.keep) {
      finalRolls.sort((a, b) => b - a);
      finalRolls = finalRolls.slice(0, options.keep);
    } else if (options.drop) {
      finalRolls.sort((a, b) => a - b);
      finalRolls = finalRolls.slice(options.drop);
    }

    const total = finalRolls.reduce((sum, roll) => sum + roll, 0) * (options.negative ? -1 : 1);

    let expr = `${count}d${sides}`;
    if (options.keep) expr += `k${options.keep}`;
    if (options.drop) expr += `d${options.drop}`;
    if (options.explode) expr += options.explodeOn ? `e${options.explodeOn}` : '!';
    if (options.reroll) expr += `r${options.reroll}`;
    if (options.negative) expr = `-${expr}`;

    return {
      total,
      rolls: allRolls,
      expression: expr,
      breakdown: this.buildBreakdown(rolls, finalRolls, options)
    };
  }

  private rollFudgeDice(count: number, options: { negative?: boolean } = {}): DiceResult {
    if (count <= 0 || count > this.MAX_DICE_COUNT) {
      throw new Error(`Dice count must be between 1 and ${this.MAX_DICE_COUNT}`);
    }

    const rolls: number[] = [];
    for (let i = 0; i < count; i++) {
      rolls.push(Math.floor(Math.random() * 3) - 1);
    }

    const total = rolls.reduce((sum, roll) => sum + roll, 0) * (options.negative ? -1 : 1);
    const fudgeSymbols = rolls.map(r => r === -1 ? '[-]' : r === 0 ? '[ ]' : '[+]');

    return {
      total,
      rolls,
      expression: `${options.negative ? '-' : ''}${count}dF`,
      breakdown: `${fudgeSymbols.join(' ')} = ${total}`
    };
  }

  private buildBreakdown(originalRolls: number[], finalRolls: number[], options: DiceModifiers): string {
    let breakdown = `[${originalRolls.join(', ')}]`;

    if (options.keep || options.drop) {
      breakdown += ` → [${finalRolls.join(', ')}]`;
    }

    breakdown += ` = ${finalRolls.reduce((sum, roll) => sum + roll, 0)}`;
    return breakdown;
  }

  private combineResults(left: DiceResult, right: DiceResult, operator: string): DiceResult {
    const total = operator === '+' ? left.total + right.total : left.total - right.total;

    return {
      total,
      rolls: [...left.rolls, ...right.rolls],
      expression: `${left.expression} ${operator} ${right.expression}`,
      breakdown: `${left.breakdown} ${operator} ${right.breakdown} = ${total}`
    };
  }

  private multiplyResults(left: DiceResult, right: DiceResult): DiceResult {
    return {
      total: left.total * right.total,
      rolls: [...left.rolls, ...right.rolls],
      expression: `${left.expression} × ${right.expression}`,
      breakdown: `(${left.breakdown}) × (${right.breakdown}) = ${left.total * right.total}`
    };
  }
}

type DiceModifiers = {
  keep?: number;
  drop?: number;
  explode?: boolean;
  explodeOn?: number;
  reroll?: number;
}

type DiceResult = {
  total: number;
  rolls: number[];
  expression: string;
  breakdown: string;
}

// Global dice server instance
const diceServer = new DiceServer();

// Helper function to get base URL
function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// Helper function to validate auth (dummy validation for public server)
const validateAuth = (request: Request): boolean => {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return true; // Allow requests without auth for public server
  
  // Check for Bearer token format (dummy validation)
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    return token.length > 10; // Dummy validation - just check it's not empty
  }
  
  return false;
};

// Helper function to handle Streamable HTTP responses
async function handleStreamableHTTPRequest(request: Request): Promise<Response> {
  if (!validateAuth(request)) {
    return new Response('Unauthorized', { 
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }

  try {
    let message;
    const body = await request.text();
    try {
      message = JSON.parse(body);
    } catch (parseError) {
      throw new Error(`Invalid JSON: ${parseError}`);
    }
    
    const response = await diceServer.handleMessage(message);
    
    // Handle notifications (no response needed)
    if (response === null) {
      return new Response('', { status: 204 });
    }
    
    // For Claude.ai integrations, always respond with SSE format
    // This ensures compatibility with their expected transport behavior
    const sseData = `data: ${JSON.stringify(response)}\n\n`;
    
    return new Response(sseData, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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
    
    const sseData = `data: ${JSON.stringify(errorResponse)}\n\n`;
    
    return new Response(sseData, {
      status: 400,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      }
    });
  }
}

// Main Worker with Streamable HTTP support
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const baseUrl = getBaseUrl(request);

    // Handle OPTIONS requests for CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cache-Control',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    // OAuth Discovery endpoint for Claude.ai integrations
    if (pathname === '/.well-known/oauth-authorization-server') {
      const oauthConfig = {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/register`,
        grant_types_supported: ["authorization_code", "client_credentials"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
        response_types_supported: ["code", "token"],
        scopes_supported: ["claudeai", "mcp"],
        subjects_supported: ["public"],
        code_challenge_methods_supported: ["S256", "plain"]
      };

      return new Response(JSON.stringify(oauthConfig), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // Dynamic Client Registration endpoint
    if (pathname === '/register' && request.method === 'POST') {
      try {
        const registration = await request.json();
        
        // Generate a dummy client ID (since we don't require real auth)
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        
        const clientInfo = {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          grant_types: ["authorization_code", "client_credentials"],
          token_endpoint_auth_method: "none",
          scope: "claudeai mcp",
          redirect_uris: registration.redirect_uris || ["https://claude.ai/api/mcp/auth_callback"]
        };

        return new Response(JSON.stringify(clientInfo), {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: "invalid_request",
          error_description: "Invalid registration request"
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });
      }
    }

    // OAuth Authorization endpoint (for authorization code flow)
    if (pathname === '/oauth/authorize' && request.method === 'GET') {
      const url = new URL(request.url);
      const clientId = url.searchParams.get('client_id');
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const scope = url.searchParams.get('scope');
      const codeChallenge = url.searchParams.get('code_challenge');
      const codeChallengeMethod = url.searchParams.get('code_challenge_method');

      if (!clientId || !redirectUri) {
        return new Response('Missing required parameters', { status: 400 });
      }

      // Generate a dummy authorization code
      const authCode = `auth_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      // Store the code challenge for later verification (in a real app you'd use a database)
      // For this demo, we'll just include it in the code itself
      const encodedCodeChallenge = codeChallenge ? btoa(codeChallenge) : '';
      const fullAuthCode = encodedCodeChallenge ? `${authCode}.${encodedCodeChallenge}` : authCode;

      // Redirect back to Claude.ai with the authorization code
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set('code', fullAuthCode);
      if (state) redirectUrl.searchParams.set('state', state);

      return new Response(null, {
        status: 302,
        headers: {
          'Location': redirectUrl.toString(),
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // OAuth Token endpoint (for client_credentials flow and authorization code exchange)
    if (pathname === '/oauth/token' && request.method === 'POST') {
      try {
        const contentType = request.headers.get('content-type');
        let grantType, code, clientId, codeVerifier;

        if (contentType?.includes('application/x-www-form-urlencoded')) {
          const formData = await request.formData();
          grantType = formData.get('grant_type');
          code = formData.get('code');
          clientId = formData.get('client_id');
          codeVerifier = formData.get('code_verifier');
        } else {
          const body = await request.json();
          grantType = body.grant_type;
          code = body.code;
          clientId = body.client_id;
          codeVerifier = body.code_verifier;
        }

        if (grantType === 'authorization_code') {
          // Handle authorization code exchange
          if (!code) {
            return new Response(JSON.stringify({
              error: "invalid_request",
              error_description: "Missing authorization code"
            }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }

          // For demo purposes, we'll just verify the code format and generate a token
          const token = {
            access_token: `access_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "claudeai"
          };

          return new Response(JSON.stringify(token), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            }
          });
        } else if (grantType === 'client_credentials') {
          // Handle client credentials flow
          const token = {
            access_token: `token_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "mcp"
          };

          return new Response(JSON.stringify(token), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            }
          });
        } else {
          return new Response(JSON.stringify({
            error: "unsupported_grant_type",
            error_description: "Only authorization_code and client_credentials grant types are supported"
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({
          error: "invalid_request",
          error_description: "Invalid token request"
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });
      }
    }

    // MCP endpoint with Streamable HTTP transport
    if (pathname === '/mcp') {
      if (request.method === 'GET') {
        // Debug logging for GET requests
        console.log('=== MCP GET REQUEST ===');
        console.log('Headers:', Object.fromEntries(request.headers.entries()));
        console.log('URL:', request.url);
        
        // Handle initial connection for Claude.ai integrations
        if (!validateAuth(request)) {
          console.log('GET request failed auth validation');
          return new Response('Unauthorized', { 
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer',
              'Access-Control-Allow-Origin': '*',
            }
          });
        }

        console.log('GET request passed auth, sending SSE connection');
        
        // Send initial SSE connection for Claude.ai integrations
        const sseData = [
          'data: {"type":"connection","status":"connected"}\n\n',
          'data: {"type":"server_info","name":"Dice Rolling Server","version":"2.0.0"}\n\n'
        ].join('');

        return new Response(sseData, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          }
        });
      } else if (request.method === 'POST') {
        // Debug logging - temporarily log all requests
        const body = await request.text();
        console.log('=== MCP POST REQUEST ===');
        console.log('Headers:', Object.fromEntries(request.headers.entries()));
        console.log('Body:', body);
        
        // Recreate request for processing
        const newRequest = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: body
        });
        return handleStreamableHTTPRequest(newRequest);
      }
    }

    // Legacy SSE endpoint for backward compatibility (keep for mcp-remote)
    if (pathname.startsWith('/sse')) {
      if (!validateAuth(request)) {
        return new Response('Unauthorized', { 
          status: 401,
          headers: {
            'WWW-Authenticate': 'Bearer',
            'Access-Control-Allow-Origin': '*',
          }
        });
      }

      if (request.method === 'GET') {
        // Initial SSE connection - send a proper SSE response
        const sseData = [
          'data: {"type":"connection","status":"connected"}\n\n',
          'data: {"type":"server_info","name":"Dice Rolling Server","version":"2.0.0"}\n\n'
        ].join('');

        return new Response(sseData, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          }
        });
      } else if (request.method === 'POST') {
        // Handle MCP messages via SSE
        try {
          const message = await request.json();
          const response = await diceServer.handleMessage(message);
          
          return new Response(JSON.stringify(response), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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
              'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            }
          });
        }
      }
    }

    // Health check endpoint for debugging
    if (pathname === '/health') {
      return new Response(JSON.stringify({
        status: "healthy",
        timestamp: new Date().toISOString(),
        version: "2.0.0",
        mcp_version: "2025-03-26",
        transport: "streamable-http"
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // Root endpoint with server info
    if (pathname === '/') {
      return new Response(JSON.stringify({
        name: "Dice Rolling Server",
        version: "2.0.0",
        description: "A stateless Model Context Protocol server for rolling dice with advanced notation.",
        transport: "streamable-http",
        endpoints: {
          mcp: `${baseUrl}/mcp`,
          sse: `${baseUrl}/sse`,
          oauth_discovery: `${baseUrl}/.well-known/oauth-authorization-server`,
          authorize: `${baseUrl}/oauth/authorize`,
          register: `${baseUrl}/register`,
          token: `${baseUrl}/oauth/token`,
          health: `${baseUrl}/health`
        },
        authentication: {
          type: "oauth2",
          flows: ["authorization_code", "client_credentials"],
          required: false,
          description: "Public server with dummy OAuth for Claude.ai integration compatibility"
        },
        tools: [
          {
            name: "roll",
            description: "Roll dice using advanced notation",
            examples: [
              "roll 2d6",
              "roll 4d6k3",
              "roll d20+5",
              "roll 2d10!",
              "roll (2d6+3)*2"
            ]
          }
        ],
        dice_notation: {
          basic: "NdX (e.g., 2d6, d20, d%)",
          keep_drop: "NdXkY (keep highest Y), NdXdY (drop lowest Y)",
          exploding: "NdX! (explode on max), NdXeY (explode on Y+)",
          reroll: "NdXrY (reroll if result is Y or less)",
          fudge: "NdF (FATE dice: -1, 0, +1)",
          math: "Supports +, -, *, parentheses",
          limits: {
            dice_count: "1-1,000",
            dice_sides: "1-10,000",
            numbers: "Up to 1,000,000"
          }
        }
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
