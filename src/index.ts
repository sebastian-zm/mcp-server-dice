import { McpAgent } from "@cloudflare/agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";

interface Env {
  DICE_KV: KVNamespace; // For rate limiting
  ACCESS_AUD?: string; // Cloudflare Access audience tag (optional)
  ACCESS_TEAM_DOMAIN?: string; // Your Cloudflare Access team domain (optional)
}

interface AuthContext {
  user?: {
    id: string;
    email?: string;
  };
  isAuthenticated: boolean;
  rateLimitKey: string;
}

// Dice notation parser
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

// Cloudflare Access JWT verification
async function verifyAccessJWT(jwt: string, aud: string, teamDomain: string): Promise<any> {
  try {
    // Fetch Cloudflare Access public keys
    const certsResponse = await fetch(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
    if (!certsResponse.ok) {
      throw new Error('Failed to fetch Access certificates');
    }
    const { keys } = await certsResponse.json();
    
    // Parse JWT
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    
    const [headerB64, payloadB64, signatureB64] = parts;
    
    // Decode header to get key ID
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    
    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      throw new Error('JWT expired');
    }
    
    // Check not before
    if (payload.nbf && payload.nbf > now) {
      throw new Error('JWT not yet valid');
    }
    
    // Verify audience
    const audArray = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audArray.includes(aud)) {
      throw new Error('Invalid audience');
    }
    
    // Find the key used to sign this JWT
    const key = keys.find((k: any) => k.kid === header.kid);
    if (!key) {
      throw new Error('Key not found');
    }
    
    // Import the public key
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      key,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['verify']
    );
    
    // Prepare data for verification
    const encoder = new TextEncoder();
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(
      atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );
    
    // Verify signature
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      signature,
      data
    );
    
    if (!valid) {
      throw new Error('Invalid signature');
    }
    
    // Return user info
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
    };
  } catch (error) {
    console.error('JWT verification error:', error);
    return null;
  }
}

export class DiceMCP extends McpAgent<Env, unknown, AuthContext> {
  server = new McpServer({
    name: "Dice Rolling Server",
    version: "2.0.0"
  });

  private parser = new DiceParser();

  async init() {
    // Universal dice rolling tool
    this.server.tool(
      "roll",
      {
        expression: z.string().describe(`Dice expression to evaluate. Supports:
• Basic: 2d6, d20, d%
• Keep/Drop: 4d6k3 (keep highest 3), 5d8d2 (drop lowest 2)
• Exploding: 3d6! (explode on max), 2d10e8 (explode on 8+)
• Reroll: 4d6r1 (reroll 1s)
• Fudge: 4dF (FATE dice)
• Math: d20+5, 2d6+1d4-2
• Multiplication: 3*(2d6+1), 2×(d4+d6)
• Complex: (2d6+3)*2+1d4-3d8k2`),
        description: z.string().optional().describe("Optional description of what this roll is for")
      },
      async ({ expression, description }, context) => {
        // Extract authentication context
        const authContext = await this.getAuthContext(context.request);
        const rateLimitKey = authContext.rateLimitKey;
        const userTier = 'standard'; // Everyone gets same limits

        // Rate limiting check
        const rateLimitCheck = await this.checkRateLimit(rateLimitKey, userTier);
        if (rateLimitCheck.limited) {
          return {
            content: [
              {
                type: "text",
                text: `⚠️ **Rate limit exceeded**\n\n${rateLimitCheck.reason}\n\nTry again in ${rateLimitCheck.resetIn} seconds.`
              }
            ],
          };
        }

        try {
          const result = this.parser.parse(expression);

          // Format the result
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

          return {
            content: [{ type: "text", text: output }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `❌ **Invalid dice expression**: ${error.message}\n\n**Examples:**\n• Basic: \`2d6\`, \`d20\`, \`d%\`\n• Advanced: \`4d6k3\`, \`3d6!\`, \`2*(d4+d6)\`\n• Complex: \`d20+5\`, \`(2d6+3)*2+1d4\``
              }
            ],
          };
        }
      },
      "Roll dice using advanced notation. Supports complex expressions, keep/drop, exploding dice, and more."
    );

    // Rate limit status tool for users
    this.server.tool(
      "rate_limit_status",
      {},
      async (params, context) => {
        const authContext = await this.getAuthContext(context.request);
        const rateLimitKey = authContext.rateLimitKey;
        const userTier = 'standard'; // Everyone gets same limits

        const now = Date.now();
        const minuteKey = `rate_limit_minute:${rateLimitKey}:${Math.floor(now / 60000)}`;
        const hourKey = `rate_limit_hour:${rateLimitKey}:${Math.floor(now / 3600000)}`;
        const dayKey = `rate_limit_day:${rateLimitKey}:${Math.floor(now / 86400000)}`;

        const limits = {
          'standard': { minute: 50, hour: 2000, day: 10000 },
        };

        const userLimits = limits[userTier];

        const [minuteCount, hourCount, dayCount] = await Promise.all([
          this.context.env.DICE_KV.get(minuteKey).then(v => v ? parseInt(v) : 0),
          this.context.env.DICE_KV.get(hourKey).then(v => v ? parseInt(v) : 0),
          this.context.env.DICE_KV.get(dayKey).then(v => v ? parseInt(v) : 0)
        ]);

        let statusText = `🎲 **Rate Limit Status**\n`;
        statusText += `Access: ${authContext.isAuthenticated ? 'Authenticated' : 'Anonymous (IP-based)'}\n`;
        if (authContext.user?.email) {
          statusText += `User: ${authContext.user.email}\n`;
        }
        statusText += `\n`;

        statusText += `• **This minute**: ${minuteCount}/${userLimits.minute} rolls\n` +
                     `• **This hour**: ${hourCount}/${userLimits.hour} rolls\n` +
                     `• **Today**: ${dayCount}/${userLimits.day} rolls\n\n` +
                     `**Remaining:**\n` +
                     `• ${userLimits.minute - minuteCount} rolls this minute\n` +
                     `• ${userLimits.hour - hourCount} rolls this hour\n` +
                     `• ${userLimits.day - dayCount} rolls today`;

        // Mention Cloudflare Access authentication if not authenticated
        if (!authContext.isAuthenticated && this.context.env.ACCESS_TEAM_DOMAIN) {
          statusText += `\n\n💡 Optional authentication available (useful for shared IPs/VPNs)`;
        }

        return {
          content: [{ type: "text", text: statusText }],
        };
      },
      "Check your current rate limit status and remaining rolls"
    );
  }

  private async getAuthContext(request: Request): Promise<AuthContext> {
    // Check for Cloudflare Access JWT
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
    
    if (jwt && this.context.env.ACCESS_AUD && this.context.env.ACCESS_TEAM_DOMAIN) {
      const user = await verifyAccessJWT(jwt, this.context.env.ACCESS_AUD, this.context.env.ACCESS_TEAM_DOMAIN);
      if (user) {
        return {
          user: { id: user.sub, email: user.email },
          isAuthenticated: true,
          rateLimitKey: `user:${user.sub}`
        };
      }
    }

    // Fall back to IP-based rate limiting
    const clientIP = this.getClientIP(request);
    return {
      isAuthenticated: false,
      rateLimitKey: `ip:${clientIP}`
    };
  }

  private getClientIP(request: Request): string {
    // Try different headers in order of preference
    const headers = request.headers;

    // Cloudflare's connecting IP header (most reliable)
    const cfIP = headers.get('CF-Connecting-IP');
    if (cfIP) return cfIP;

    // Fallback headers
    const xForwardedFor = headers.get('X-Forwarded-For');
    if (xForwardedFor) {
      // Take the first IP if there are multiple
      return xForwardedFor.split(',')[0].trim();
    }

    const xRealIP = headers.get('X-Real-IP');
    if (xRealIP) return xRealIP;

    // Last resort - this shouldn't happen in Cloudflare Workers
    return 'unknown';
  }

  private async checkRateLimit(rateLimitKey: string, userTier: string = 'standard'): Promise<{limited: boolean, reason?: string, resetIn?: number}> {
    const now = Date.now();
    const minuteKey = `rate_limit_minute:${rateLimitKey}:${Math.floor(now / 60000)}`;
    const hourKey = `rate_limit_hour:${rateLimitKey}:${Math.floor(now / 3600000)}`;
    const dayKey = `rate_limit_day:${rateLimitKey}:${Math.floor(now / 86400000)}`;

    const limits = {
      'standard': { minute: 50, hour: 2000, day: 10000 },
    };

    const userLimits = limits[userTier];

    // Get current counts
    const [minuteCount, hourCount, dayCount] = await Promise.all([
      this.context.env.DICE_KV.get(minuteKey).then(v => v ? parseInt(v) : 0),
      this.context.env.DICE_KV.get(hourKey).then(v => v ? parseInt(v) : 0),
      this.context.env.DICE_KV.get(dayKey).then(v => v ? parseInt(v) : 0)
    ]);

    // Check limits
    if (minuteCount >= userLimits.minute) {
      return {
        limited: true,
        reason: `Too many rolls per minute (${userLimits.minute}/min limit)`,
        resetIn: 60 - (Math.floor(now / 1000) % 60)
      };
    }
    if (hourCount >= userLimits.hour) {
      return {
        limited: true,
        reason: `Too many rolls per hour (${userLimits.hour}/hour limit)`,
        resetIn: 3600 - (Math.floor(now / 1000) % 3600)
      };
    }
    if (dayCount >= userLimits.day) {
      return {
        limited: true,
        reason: `Daily limit reached (${userLimits.day}/day limit)`,
        resetIn: 86400 - (Math.floor(now / 1000) % 86400)
      };
    }

    // Update counters
    await Promise.all([
      this.context.env.DICE_KV.put(minuteKey, (minuteCount + 1).toString(), { expirationTtl: 120 }),
      this.context.env.DICE_KV.put(hourKey, (hourCount + 1).toString(), { expirationTtl: 7200 }),
      this.context.env.DICE_KV.put(dayKey, (dayCount + 1).toString(), { expirationTtl: 172800 })
    ]);

    return { limited: false };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    // MCP endpoints - handle both SSE and standard
    if (pathname.startsWith('/sse') || pathname.startsWith('/mcp')) {
      if (pathname.startsWith('/sse')) {
        return DiceMCP.serveSSE('/sse').fetch(request, env, ctx);
      } else {
        return DiceMCP.serve('/mcp').fetch(request, env, ctx);
      }
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
        endpoints: {
          sse: request.url + "sse",
          mcp: request.url + "mcp"
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

    return new Response('Not found', { status: 404 });
  },
};
