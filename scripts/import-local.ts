/**
 * One-off import: D1/KV migration dumps → local libSQL database.
 * Reuses scripts/migrate-to-libsql.ts verbatim; sources are copied from the
 * old project (opensourcegithub/缠论/chan-dashboard, exported 2026-11-20).
 *
 * Usage: node scripts/import-local.ts <source-dir>
 *   e.g. node scripts/import-local.ts "C:\Users\lee\Desktop\opensourcegithub\缠论\chan-dashboard"
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, process.argv[2] ?? '.');
const url = process.env.TURSO_DATABASE_URL || 'file:./chan.db';

const sources = ['d1-instrument.json', 'd1-market-cache.json', 'd1-catalog-meta.json', 'kv-backup.json'];
for (const f of sources) {
  const from = resolve(src, f);
  if (!existsSync(from)) { console.error(`缺少迁移源文件: ${from}`); process.exit(1); }
  cpSync(from, resolve(root, f));
  console.log(`copied: ${f}`);
}

console.log(`migrating into ${url} ...`);
const result = spawnSync(process.execPath, ['scripts/migrate-to-libsql.ts', url], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
