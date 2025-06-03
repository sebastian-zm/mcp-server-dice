export type Env = {
  // Optional KV for future use
  DICE_KV?: KVNamespace;
}

export type DiceModifiers = {
  keep?: number | null;
  drop?: number | null;
  explode?: boolean;
  explodeOn?: number | null;
  reroll?: number | null;
}

export type DiceResult = {
  total: number;
  rolls: number[];
  expression: string;
  breakdown: string;
}