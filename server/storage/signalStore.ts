import type { D1DatabaseLike } from './d1Types.ts';
import type { ResearchStore } from './researchStore.ts';
import type { StoredSignalEvent } from '../core/signalDiff.ts';

interface SignalRow {
  id: string; run_id: string; prev_run_id: string | null; instrument_id: string;
  name: string; market: string; kind: string; type: string; detail_json: string; created_at: string;
}

/**
 * Persistence for server-side signal events. The ResearchStore interface does
 * not model this table, so the writer takes the raw D1-like database when
 * available (Node with libSQL) and degrades to a no-op on the memory
 * driver (in-memory signals stay browser-local there).
 */
export function signalStoreFrom(store: ResearchStore): D1DatabaseLike | null {
  const raw = (store as unknown as { db?: D1DatabaseLike }).db;
  return raw && typeof raw.prepare === 'function' ? raw : null;
}

export async function saveSignalEvents(store: ResearchStore, events: StoredSignalEvent[]): Promise<void> {
  if (!events.length) return;
  const db = signalStoreFrom(store);
  if (!db) return;
  const statements = events.map((event) => db.prepare(
    'INSERT OR REPLACE INTO signal_events (id, run_id, prev_run_id, instrument_id, name, market, kind, type, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(event.id, event.runId, event.prevRunId, event.instrumentId, event.name, event.market, event.kind, event.type, JSON.stringify({ detail: event.detail }), event.createdAt));
  for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
}

export async function listSignalEvents(db: D1DatabaseLike, query: { market?: string; type?: string; since?: string; limit?: number }): Promise<StoredSignalEvent[]> {
  const filters: string[] = [];
  const params: unknown[] = [];
  if (query.market) { filters.push('market = ?'); params.push(query.market); }
  if (query.type) { filters.push('type = ?'); params.push(query.type); }
  if (query.since) { filters.push('created_at >= ?'); params.push(query.since); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await db.prepare(`SELECT * FROM signal_events ${where} ORDER BY created_at DESC LIMIT ?`).bind(...params, Math.min(500, Math.max(1, query.limit ?? 100))).all<SignalRow>();
  return rows.results.map((row) => {
    let detail = row.detail_json;
    try { detail = (JSON.parse(row.detail_json) as { detail?: string }).detail ?? row.detail_json; } catch { /* keep raw */ }
    return { id: row.id, runId: row.run_id, prevRunId: row.prev_run_id, instrumentId: row.instrument_id, name: row.name, market: row.market, kind: row.kind, type: row.type as StoredSignalEvent['type'], detail, createdAt: row.created_at };
  });
}
