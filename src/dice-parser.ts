import { DiceModifiers, DiceResult } from './types';

export class DiceParser {
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