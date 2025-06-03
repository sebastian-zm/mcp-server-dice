export type Env = {
  // Optional KV for future use
  DICE_KV?: KVNamespace;
  // SQLite-based Durable Object
  SQLITE_DO: DurableObjectNamespace;
  // D1 Database for SQLite storage
  DB: D1Database;
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