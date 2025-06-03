import { DiceParser } from './dice-parser';

export class McpDiceServer {
  private parser: DiceParser;
  private serverInfo = {
    name: "Dice Rolling Server",
    version: "2.0.0"
  };

  constructor() {
    this.parser = new DiceParser();
  }

  async handleRequest(message: any): Promise<any> {
    console.log('=== MCP REQUEST ===', JSON.stringify(message, null, 2));

    try {
      let response: any = null;

      switch (message.method) {
        case 'initialize':
          response = await this.handleInitialize(message);
          break;

        case 'notifications/initialized':
          // Notification - no response required
          console.log('Client initialized');
          return null;

        case 'tools/list':
          response = await this.handleToolsList(message);
          break;

        case 'tools/call':
          response = await this.handleToolsCall(message);
          break;

        case 'resources/list':
          response = await this.handleResourcesList(message);
          break;

        case 'prompts/list':
          response = await this.handlePromptsList(message);
          break;

        case 'logging/setLevel':
          response = await this.handleLoggingSetLevel(message);
          break;

        default:
          response = {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32601,
              message: `Method not found: ${message.method}`,
              data: { method: message.method }
            }
          };
      }

      console.log('=== MCP RESPONSE ===', JSON.stringify(response, null, 2));
      return response;

    } catch (error: any) {
      console.error('=== MCP ERROR ===', error);
      return {
        jsonrpc: "2.0",
        id: message.id || null,
        error: {
          code: -32603,
          message: "Internal error",
          data: { details: error.message }
        }
      };
    }
  }

  private async handleInitialize(message: any) {
    const { protocolVersion, capabilities, clientInfo } = message.params || {};
    
    console.log('Client info:', clientInfo);
    console.log('Client capabilities:', capabilities);

    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          logging: {}
        },
        serverInfo: this.serverInfo
      }
    };
  }

  private async handleToolsList(message: any) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "roll",
            description: "Roll dice using advanced notation. Supports complex expressions, modifiers, and mathematical operations.",
            inputSchema: {
              type: "object",
              properties: {
                expression: {
                  type: "string",
                  description: `Dice expression to evaluate. Supported notation:
• Basic: 2d6, d20, d% (percentile), 4dF (Fudge dice)
• Keep/Drop: 4d6k3 (keep highest 3), 5d8d2 (drop lowest 2)  
• Exploding: 3d6! (explode on max), 2d10e8 (explode on 8+)
• Reroll: 4d6r1 (reroll results of 1 or less)
• Math: d20+5, 2d6+1d4-2, 3*(2d6+1)
• Complex: (2d6+3)*2+1d4-3d8k2

Examples: "2d6+3", "4d6k3", "d20+5", "3d6!", "(2d4+1)*3"`
                },
                description: {
                  type: "string",
                  description: "Optional description of what this roll represents (e.g. 'Attack roll', 'Damage', 'Ability score')"
                }
              },
              required: ["expression"],
              additionalProperties: false
            }
          }
        ]
      }
    };
  }

  private async handleToolsCall(message: any) {
    const { name, arguments: args } = message.params || {};

    if (name !== "roll") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32602,
          message: `Unknown tool: ${name}`,
          data: { tool: name }
        }
      };
    }

    try {
      const { expression, description } = args || {};
      
      if (!expression || typeof expression !== 'string') {
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32602,
            message: "Invalid parameters: 'expression' is required and must be a string",
            data: { received: args }
          }
        };
      }

      const result = this.parser.parse(expression);

      let output = `🎲 **${result.expression}**`;
      if (description) {
        output += ` *(${description})*`;
      }
      output += `\n\n${result.breakdown}\n\n**Result: ${result.total}**`;

      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: output
            }
          ]
        }
      };

    } catch (error: any) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: `❌ **Invalid dice expression**: ${error.message}

**Examples:**
• Basic: \`2d6\`, \`d20\`, \`d%\`, \`4dF\`
• Modifiers: \`4d6k3\`, \`3d6!\`, \`2d10e8\`, \`4d6r1\`
• Math: \`d20+5\`, \`2d6+1d4-2\`, \`3*(2d6+1)\`
• Complex: \`(2d6+3)*2+1d4\`, \`3d8k2+d4\``
            }
          ]
        }
      };
    }
  }

  private async handleResourcesList(message: any) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        resources: []
      }
    };
  }

  private async handlePromptsList(message: any) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        prompts: []
      }
    };
  }

  private async handleLoggingSetLevel(message: any) {
    const { level } = message.params || {};
    console.log(`Logging level set to: ${level}`);
    
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {}
    };
  }
}