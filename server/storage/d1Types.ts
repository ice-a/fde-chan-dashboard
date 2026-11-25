/**
 * Minimal structural types for the D1-style SQL interface (libSQL compatible).
 * Avoids platform-specific imports so the same code typechecks under Node.
 */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<{ success: boolean }[]>;
}

export function asD1(db: unknown): D1DatabaseLike {
  if (!db || typeof (db as D1DatabaseLike).prepare !== 'function') throw new Error('D1 数据库绑定不可用');
  return db as D1DatabaseLike;
}
