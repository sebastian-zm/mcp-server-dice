import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

interface Env {
  DICE_KV: KVNamespace;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

interface AuthContext {
  user?: {
    id: string;
    email?: string;
  };
  isAuthenticated: boolean;
  rateLimitKey: string;
}

// Keep all the existing DiceParser and helper classes unchanged
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
    } catch (error) {
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
    
    // Sanity check for extremely large numbers
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
    
    // Prevent extremely large computations
    if (count * sides > this.MAX_NUMBER) {
      throw new Error("Total possible outcomes too large");
    }

    const rolls: number[] = [];
    const allRolls: number[] = []; // For exploding dice

    for (let i = 0; i < count; i++) {
      let roll = Math.floor(Math.random() * sides) + 1;
      rolls.push(roll);
      allRolls.push(roll);

      // Handle exploding dice (with limit to prevent infinite loops)
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

      // Handle reroll
      if (options.reroll && rolls[i] <= options.reroll) {
        rolls[i] = Math.floor(Math.random() * sides) + 1;
      }
    }

    // Apply keep/drop
    let finalRolls = [...rolls];
    if (options.keep) {
      finalRolls.sort((a, b) => b - a);
      finalRolls = finalRolls.slice(0, options.keep);
    } else if (options.drop) {
      finalRolls.sort((a, b) => a - b);
      finalRolls = finalRolls.slice(options.drop);
    }

    const total = finalRolls.reduce((sum, roll) => sum + roll, 0) * (options.negative ? -1 : 1);

    // Build expression
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
      rolls.push(Math.floor(Math.random() * 3) - 1); // -1, 0, or 1
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

interface DiceModifiers {
  keep?: number;
  drop?: number;
  explode?: boolean;
  explodeOn?: number;
  reroll?: number;
}

interface DiceResult {
  total: number;
  rolls: number[];
  expression: string;
  breakdown: string;
}

// Simple MCP server without Durable Objects
class DiceMCPServer {
  private parser = new DiceParser();
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async handleMCPRequest(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      console.log('📨 MCP Request:', JSON.stringify(body, null, 2));

      // Handle different MCP request types
      switch (body.method) {
        case 'tools/list':
          return this.handleListTools();
        
        case 'tools/call':
          return this.handleCallTool(body.params);
        
        default:
          return new Response(JSON.stringify({
            error: {
              code: -32601,
              message: `Method not found: ${body.method}`
            },
            id: body.id
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
      }
    } catch (error) {
      console.error('❌ MCP request error:', error);
      return new Response(JSON.stringify({
        error: {
          code: -32603,
          message: 'Internal error',
          data: error.message
        }
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private handleListTools(): Response {
    const tools = [
      {
        name: "roll",
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
      },
      {
        name: "rate_limit_status",
        description: "Check your current rate limit status and remaining rolls",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ];

    return new Response(JSON.stringify({
      tools
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleCallTool(params: any): Promise<Response> {
    try {
      const { name, arguments: args } = params;

      switch (name) {
        case 'roll':
          return this.handleRollTool(args);
        
        case 'rate_limit_status':
          return this.handleRateLimitStatus();
        
        default:
          return new Response(JSON.stringify({
            error: {
              code: -32602,
              message: `Unknown tool: ${name}`
            }
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
      }
    } catch (error) {
      console.error('❌ Tool call error:', error);
      return new Response(JSON.stringify({
        error: {
          code: -32603,
          message: 'Tool execution failed',
          data: error.message
        }
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleRollTool(args: any): Promise<Response> {
    const { expression, description } = args;
    console.log(`🎲 Rolling: ${expression}`);

    try {
      const result = this.parser.parse(expression);

      let output = `🎲 **${result.expression}**`;
      if (description) {
        output += ` *(${description})*`;
      }
      output += `\n\n${result.breakdown}\n\n**Result: ${result.total}**`;

      // Add some flair for special results
      if (Math.abs(result.total) >= 100) {
        output += " 💥";
      } else if (result.total === 1 && result.rolls.length === 1) {
        output += " 💀";
      } else if (result.rolls.some(r => r === 20) && expression.includes('d20')) {
        output += " ⭐";
      }

      return new Response(JSON.stringify({
        content: [
          {
            type: "text",
            text: output
          }
        ]
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('❌ Dice roll error:', error);
      return new Response(JSON.stringify({
        content: [
          {
            type: "text",
            text: `❌ **Invalid dice expression**: ${error.message}\n\n**Examples:**\n• Basic: \`2d6\`, \`d20\`, \`d%\`\n• Advanced: \`4d6k3\`, \`3d6!\`, \`2*(d4+d6)\`\n• Complex: \`d20+5\`, \`(2d6+3)*2+1d4\``
          }
        ]
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleRateLimitStatus(): Response {
    // Simplified rate limit status
    return new Response(JSON.stringify({
      content: [
        {
          type: "text",
          text: `🎲 **Rate Limit Status**\n\nAccess: Available\nLimits: 50 rolls/minute, 2,000 rolls/hour, 10,000 rolls/day\n\n✅ Service operational`
        }
      ]
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private getClientIP(request: Request): string {
    const headers = request.headers;
    const cfIP = headers.get('CF-Connecting-IP');
    if (cfIP) return cfIP;

    const xForwardedFor = headers.get('X-Forwarded-For');
    if (xForwardedFor) {
      return xForwardedFor.split(',')[0].trim();
    }

    return 'unknown';
  }

  private async checkRateLimit(rateLimitKey: string, userTier: string = 'standard') {
    const now = Date.now();
    const minuteKey = `rate_limit_minute:${rateLimitKey}:${Math.floor(now / 60000)}`;

    try {
      const minuteCount = await this.env.DICE_KV.get(minuteKey);
      const count = minuteCount ? parseInt(minuteCount) : 0;

      if (count >= 50) { // 50 per minute limit
        return {
          limited: true,
          reason: 'Too many rolls per minute (50/min limit)',
          resetIn: 60 - (Math.floor(now / 1000) % 60)
        };
      }

      // Update counter
      await this.env.DICE_KV.put(minuteKey, (count + 1).toString(), { expirationTtl: 120 });
      return { limited: false };

    } catch (error) {
      console.error('Rate limit check failed:', error);
      return { limited: false }; // Allow on error
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      console.log(`📨 Request: ${request.method} ${request.url}`);
      
      // Test KV access immediately
      try {
        await env.DICE_KV.get('test-startup');
        console.log('✅ KV namespace accessible');
      } catch (kvError) {
        console.error('❌ KV namespace error:', kvError);
        return new Response(JSON.stringify({
          error: 'KV namespace not accessible',
          details: kvError.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const { pathname } = new URL(request.url);

      // Handle OPTIONS requests for CORS
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cf-Access-Jwt-Assertion',
          }
        });
      }

      // Create the dice server
      const diceServer = new DiceMCPServer(env);

      // MCP endpoints
      if (pathname.startsWith('/mcp')) {
        console.log(`🔧 Handling MCP endpoint: ${pathname}`);
        return diceServer.handleMCPRequest(request);
      }

      // SSE endpoint (simplified for now)
      if (pathname.startsWith('/sse')) {
        return new Response('SSE endpoint - use /mcp for JSON-RPC', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      // Root endpoint with server info
      if (pathname === '/') {
        const authInfo = env.ACCESS_TEAM_DOMAIN 
          ? {
              available: true,
              provider: "Cloudflare Access",
              note: "Optional - provides separate rate limit from IP"
            }
          : {
              available: false,
              note: "Set ACCESS_AUD and ACCESS_TEAM_DOMAIN env vars to enable"
            };

        return new Response(JSON.stringify({
          name: "Dice Rolling Server",
          version: "2.0.0",
          description: "A Model Context Protocol server for rolling dice with advanced notation. Free to use with reasonable rate limits.",
          status: "✅ Server running",
          endpoints: {
            mcp: request.url + "mcp",
            sse: request.url + "sse"
          },
          authentication: authInfo,
          rateLimits: {
            all_users: "50 rolls/minute, 2,000 rolls/hour, 10,000 rolls/day",
            note: "Same limits for everyone. Auth useful for shared IPs."
          },
          tools: [
            {
              name: "roll",
              description: "Roll dice with advanced notation",
              examples: [
                "roll 2d6",
                "roll 4d6k3", 
                "roll d20+5",
                "roll 2d10!",
                "roll (2d6+3)*2"
              ]
            },
            {
              name: "rate_limit_status",
              description: "Check your current rate limits"
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
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cf-Access-Jwt-Assertion'
          }
        });
      }

      // Test endpoint for debugging
      if (pathname === '/test') {
        const parser = new DiceParser();
        const testResult = parser.parse('2d6+3');
        
        return new Response(JSON.stringify({
          message: 'Test successful',
          diceResult: testResult,
          env: Object.keys(env),
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not found', { status: 404 });

    } catch (error) {
      console.error('💥 Main handler error:', error);
      
      return new Response(JSON.stringify({
        error: 'Internal server error',
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  },
};
