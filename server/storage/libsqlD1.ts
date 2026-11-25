import type { Client, InValue } from '@libsql/client/web';
import type { D1DatabaseLike, D1Statement } from './d1Types.ts';

/**
 * Presents a libSQL client (Turso Cloud / sqld / file:) through the same
 * minimal D1 interface, so D1ResearchStore and D1MarketCache run unchanged
 * on top of libSQL. Only type imports here; callers construct the runtime
 * client ('@libsql/client' on Node, any platform).
 */
class LibSqlStatement implements D1Statement {
  readonly client: Client;
  readonly sql: string;
  readonly args: InValue[];
  constructor(client: Client, sql: string, args: InValue[]) {
    this.client = client;
    this.sql = sql;
    this.args = args;
  }

  bind(...values: unknown[]): D1Statement {
    return new LibSqlStatement(this.client, this.sql, values as InValue[]);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const rs = await this.client.execute({ sql: this.sql, args: this.args });
    return (rs.rows[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }> {
    const rs = await this.client.execute({ sql: this.sql, args: this.args });
    return { results: rs.rows as unknown as T[], success: true };
  }

  async run(): Promise<{ success: boolean; meta?: Record<string, unknown> }> {
    const rs = await this.client.execute({ sql: this.sql, args: this.args });
    return {
      success: true,
      meta: { changes: rs.rowsAffected, last_row_id: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : 0 },
    };
  }
}

export class LibSqlDatabase implements D1DatabaseLike {
  private readonly client: Client;
  constructor(client: unknown) {
    if (!client || typeof (client as Client).execute !== 'function' || typeof (client as Client).batch !== 'function') {
      throw new Error('libSQL 客户端不可用：需要提供 @libsql/client 的 Client 实例');
    }
    this.client = client as Client;
  }

  prepare(sql: string): D1Statement {
    return new LibSqlStatement(this.client, sql, []);
  }

  async batch(statements: D1Statement[]): Promise<{ success: boolean }[]> {
    if (!statements.length) return [];
    // 'write' opens an immediate transaction, matching D1's batch semantics.
    // Every statement comes from prepare(), so it is a LibSqlStatement.
    await this.client.batch(
      statements.map((statement) => {
        const own = statement as LibSqlStatement;
        return { sql: own.sql, args: own.args };
      }),
      'write',
    );
    return statements.map(() => ({ success: true }));
  }
}
