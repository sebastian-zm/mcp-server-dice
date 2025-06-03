import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  DICE_KV: KVNamespace;
  DICE_MCP: DurableObjectNamespace;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

// Durable Object implementation
export class DiceMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Dice Rolling Server",
    version: "2.0.0"
  });

  private parser = new DiceParser();
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super();
    // Initialize SQLite storage
    this.sql = ctx.storage.sql;
    
    // Initialize database tables
    this.initializeDatabase();
  }

  private async initializeDatabase() {
    // Create tables for storing dice roll history, user preferences, etc.
    await this.sql.exec(`
      CREATE TABLE IF NOT EXISTS dice_rolls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        expression TEXT,
        result INTEGER,
        breakdown TEXT,
        user_id TEXT,
        description TEXT
      )
    `);

    await this.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY,
        default_notation TEXT,
        history_enabled BOOLEAN DEFAULT true,
        created_at INTEGER
      )
    `);
  }

  async init() {
    // Universal dice rolling tool with history tracking
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
        description: z.string().optional().describe("Optional description of what this roll is for"),
        save_to_history: z.boolean().optional().default(true).describe("Whether to save this roll to history")
      },
      async ({ expression, description, save_to_history }) => {
        try {
          const result = this.parser.parse(expression);

          // Save to history if requested
          if (save_to_history) {
            await this.saveRollToHistory({
              expression: result.expression,
              result: result.total,
              breakdown: result.breakdown,
              description: description || null,
              user_id: 'default', // You could extract this from request context
              timestamp: Date.now()
            });
          }

          let output = `🎲 **${result.expression}**`;
          if (description) {
            output += ` *(${description})*`;
          }
          output += `\n\n${result.breakdown}\n\n**Result: ${result.total}**`;

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

    // Add history tool
    this.server.tool(
      "roll_history",
      {
        limit: z.number().optional().default(10).describe("Number of recent rolls to retrieve"),
        user_id: z.string().optional().default('default').describe("User ID to get history for")
      },
      async ({ limit, user_id }) => {
        const rolls = await this.getRollHistory(user_id, limit);
        
        if (rolls.length === 0) {
          return {
            content: [{ type: "text", text: "📜 No dice roll history found." }]
          };
        }

        let output = `📜 **Recent Dice Rolls** (${rolls.length} results)\n\n`;
        for (const roll of rolls) {
          const date = new Date(roll.timestamp).toLocaleString();
          output += `• **${roll.expression}** = ${roll.result}`;
          if (roll.description) {
            output += ` *(${roll.description})*`;
          }
          output += `\n  ${roll.breakdown}\n  *${date}*\n\n`;
        }

        return {
          content: [{ type: "text", text: output }]
        };
      },
      "Get history of recent dice rolls"
    );

    // Clear history tool
    this.server.tool(
      "clear_history",
      {
        user_id: z.string().optional().default('default').describe("User ID to clear history for"),
        confirm: z.boolean().describe("Must be true to confirm deletion")
      },
      async ({ user_id, confirm }) => {
        if (!confirm) {
          return {
            content: [{ 
              type: "text", 
              text: "❌ **Confirmation required**: Set `confirm: true` to clear history." 
            }]
          };
        }

        const result = await this.sql.exec(
          "DELETE FROM dice_rolls WHERE user_id = ?",
          user_id
        );

        return {
          content: [{ 
            type: "text", 
            text: `✅ **History cleared**: Deleted ${result.changes} roll records for user ${user_id}.` 
          }]
        };
      },
      "Clear dice roll history for a user"
    );
  }

  // Durable Object fetch method
  async fetch(request: Request): Promise<Response> {
    // Initialize the MCP agent if not already done
    if (!this.server.listTools().length) {
      await this.init();
    }

    // Handle MCP requests through the agent
    return await super.fetch(request);
  }

  // Helper methods for database operations
  private async saveRollToHistory(roll: {
    expression: string;
    result: number;
    breakdown: string;
    description: string | null;
    user_id: string;
    timestamp: number;
  }) {
    await this.sql.exec(
      `INSERT INTO dice_rolls (expression, result, breakdown, description, user_id, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      roll.expression,
      roll.result,
      roll.breakdown,
      roll.description,
      roll.user_id,
      roll.timestamp
    );
  }

  private async getRollHistory(user_id: string, limit: number) {
    const result = await this.sql.exec(
      `SELECT * FROM dice_rolls 
       WHERE user_id = ? 
       ORDER BY timestamp DESC 
       LIMIT ?`,
      user_id,
      limit
    );

    return result.results.map(row => ({
      id: row.id as number,
      expression: row.expression as string,
      result: row.result as number,
      breakdown: row.breakdown as string,
      description: row.description as string | null,
      user_id: row.user_id as string,
      timestamp: row.timestamp as number
    }));
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

// Main Worker
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

    // Route MCP requests to the Durable Object
    if (pathname.startsWith('/sse') || pathname.startsWith('/mcp')) {
      // Get a Durable Object instance
      const id = env.DICE_MCP.idFromName('dice-mcp-instance');
      const durableObject = env.DICE_MCP.get(id);
      
      // Forward the request to the Durable Object
      return durableObject.fetch(request);
    }

    // Root endpoint with server info (updated with new tools)
    if (pathname === '/') {
      return new Response(JSON.stringify({
        name: "Dice Rolling Server",
        version: "2.0.0",
        description: "A Model Context Protocol server for rolling dice with advanced notation and SQLite-backed history.",
        storage: "SQLite Durable Objects",
        endpoints: {
          sse: new URL('/sse', request.url).href,
          mcp: new URL('/mcp', request.url).href
        },
        tools: [
          {
            name: "roll",
            description: "Roll dice with advanced notation and optional history saving",
            examples: [
              "roll 2d6",
              "roll 4d6k3",
              "roll d20+5",
              "roll 2d10!",
              "roll (2d6+3)*2"
            ]
          },
          {
            name: "roll_history",
            description: "Get history of recent dice rolls",
            examples: [
              "roll_history",
              "roll_history limit=5"
            ]
          },
          {
            name: "clear_history",
            description: "Clear dice roll history",
            examples: [
              "clear_history confirm=true"
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
