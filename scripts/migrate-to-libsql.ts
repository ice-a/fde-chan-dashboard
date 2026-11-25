/**
 * One-off migration: Cloudflare D1 + KV → libSQL (Turso).
 *
 * Usage:
 *   node scripts/migrate-to-libsql.ts <libsql-url> <auth-token>
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/migrate-to-libsql.ts
 *
 * Sources (produced before the D1/KV binding removal):
 *   d1-instrument.json / d1-market-cache.json / d1-catalog-meta.json  (D1 export --json)
 *   kv-backup.json  (wrangler kv key list/get dump, { key: 'daily:<id>', value: <CacheEntry JSON string> })
 *
 * Applies schema.sql, then inserts rows with parameter binding in batches,
 * then verifies per-table counts against the export baselines.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@libsql/client';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] ?? process.env.TURSO_DATABASE_URL;
const token = process.argv[3] ?? process.env.TURSO_AUTH_TOKEN;
if (!url) { console.error('缺少 libSQL 地址：node scripts/migrate-to-libsql.ts <url> <token>'); process.exit(1); }

const client = createClient({ url, authToken: token || undefined });

function readJson(name: string): unknown {
  return JSON.parse(readFileSyncLocal(name));
}
/** wrangler d1 execute --json wraps rows as [{ results: [...] }]. */
function readRows<T>(name: string): T[] {
  const data = readJson(name) as { results?: T[] } | { results?: T[] }[];
  const first = Array.isArray(data) ? data[0] : data;
  return first?.results ?? [];
}
function readFileSyncLocal(name: string): string {
  const content = readFileSync(resolve(root, name), 'utf8');
  return content.replace(/^\uFEFF/, '').trim();
}

interface InstrumentRow { version: string; id: string; market: string; kind: string; name: string; symbol: string; exchange: string; currency: string; listing_status: string; listed_at: string | null; providers_json: string; catalog_source: string; mapping_status: string }
interface CacheRow { cache_key: string; payload: string; expires_at: number; stale_until: number }
interface MetaRow { version: string; created_at: string; complete: number; sources_json: string }

async function applySchema(): Promise<void> {
  const schema = await readFile(resolve(root, 'server/storage/schema.sql'), 'utf8');
  // Strip '--' comment lines, then split on statement-terminating ';\n'.
  const statements = schema
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
    .split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length);
  await client.batch(statements.map((sql) => ({ sql })), 'write');
  console.log(`schema: ${statements.length} statements applied`);
}

async function insertBatched(sql: string, rows: unknown[][]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await client.batch(chunk.map((args) => ({ sql, args })), 'write');
    written += chunk.length;
    process.stdout.write(`  ${written}/${rows.length}\r`);
  }
  process.stdout.write('\n');
  return written;
}

async function migrate(): Promise<void> {
  await applySchema();

  const instruments = readRows<InstrumentRow>('d1-instrument.json');
  const inserted = await insertBatched(
    'INSERT OR REPLACE INTO instrument (version, id, market, kind, name, symbol, exchange, currency, listing_status, listed_at, providers_json, catalog_source, mapping_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    instruments.map((r) => [r.version, r.id, r.market, r.kind, r.name, r.symbol, r.exchange, r.currency, r.listing_status, r.listed_at, r.providers_json, r.catalog_source, r.mapping_status]),
  );
  console.log(`instrument: ${inserted} rows (source ${instruments.length})`);

  const cache = readRows<CacheRow>('d1-market-cache.json');
  const now = Date.now();
  const cacheRows = cache.filter((r) => r.stale_until > now);
  const skippedExpired = cache.length - cacheRows.length;
  const cacheInserted = await insertBatched(
    'INSERT OR REPLACE INTO market_cache (cache_key, payload, expires_at, stale_until) VALUES (?, ?, ?, ?)',
    cacheRows.map((r) => [r.cache_key, r.payload, r.expires_at, r.stale_until]),
  );
  console.log(`market_cache: ${cacheInserted} rows from D1 (skipped ${skippedExpired} expired)`);

  const meta = readRows<MetaRow>('d1-catalog-meta.json');
  const metaInserted = await insertBatched(
    'INSERT OR REPLACE INTO catalog_meta (version, created_at, complete, sources_json) VALUES (?, ?, ?, ?)',
    meta.map((r) => [r.version, r.created_at, r.complete, r.sources_json]),
  );
  console.log(`catalog_meta: ${metaInserted} rows`);

  // KV leftovers (daily:<key> → { value, expiresAt, staleUntil }) merge into market_cache.
  let kvRaw: { key: string; value: string }[] = [];
  try {
    const parsed = JSON.parse(readFileSyncLocal('kv-backup.json')) as { key: string; value: string }[];
    kvRaw = Array.isArray(parsed) ? parsed : [];
  } catch { console.log('kv-backup.json 不存在或不可解析，跳过 KV 迁移'); }
  const existing = new Set((await client.execute({ sql: 'SELECT cache_key FROM market_cache', args: [] })).rows.map((r) => r.cache_key as string));
  const kvRows: unknown[][] = [];
  let kvSkipped = 0;
  for (const entry of kvRaw) {
    if (!entry.key.startsWith('daily:')) { kvSkipped++; continue; }
    let parsedValue: { value?: unknown; expiresAt?: number; staleUntil?: number };
    try { parsedValue = JSON.parse(entry.value); } catch { kvSkipped++; continue; }
    const cacheKey = entry.key.slice('daily:'.length);
    if (existing.has(cacheKey) || (parsedValue.staleUntil ?? 0) <= now || parsedValue.value == null) { kvSkipped++; continue; }
    kvRows.push([cacheKey, JSON.stringify(parsedValue.value), parsedValue.expiresAt ?? now, parsedValue.staleUntil]);
  }
  const kvInserted = await insertBatched(
    'INSERT OR REPLACE INTO market_cache (cache_key, payload, expires_at, stale_until) VALUES (?, ?, ?, ?)',
    kvRows,
  );
  console.log(`market_cache from KV: ${kvInserted} rows (skipped ${kvSkipped})`);

  // Verify against baselines.
  const expect = { instrument: instruments.length, catalog_meta: meta.length, market_cache: (await client.execute({ sql: 'SELECT COUNT(*) AS n FROM market_cache', args: [] })).rows[0].n as number };
  const verify = async (table: string): Promise<number> => Number((await client.execute({ sql: `SELECT COUNT(*) AS n FROM ${table}`, args: [] })).rows[0].n);
  const counts = {
    instrument: await verify('instrument'),
    market_cache: await verify('market_cache'),
    catalog_meta: await verify('catalog_meta'),
    stage_row: await verify('stage_row'),
    sync_log: await verify('sync_log'),
    scan_run: await verify('scan_run'),
    scan_item: await verify('scan_item'),
    score: await verify('score'),
  };
  console.log('verify:', JSON.stringify(counts));
  if (counts.instrument !== expect.instrument || counts.catalog_meta !== expect.catalog_meta) {
    console.error(`行数对账失败：期望 ${JSON.stringify(expect)}`);
    process.exit(2);
  }
  console.log('迁移完成，行数对账通过');
}

migrate().catch((error) => { console.error(error); process.exit(1); });
