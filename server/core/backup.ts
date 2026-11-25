/**
 * JSON snapshot backup of the whole libSQL database (local file: or remote).
 * Dumps every table row-by-row into a single dated JSON file under backups/,
 * pruning old backups beyond retention (BACKUP_KEEP, default 14). JSON keeps
 * backups human-inspectable and restorable into any future store, at the cost
 * of size — fine for this dataset (tens of MB).
 *
 * Called by scripts/backup-db.ts (manual / external scheduler) and by the
 * Node host's built-in timer (BACKUP_INTERVAL_HOURS, 0 = disabled).
 */
import { mkdir, readdir, writeFile, unlink } from 'node:fs/promises';
import type { Client } from '@libsql/client';

export interface BackupOptions {
  client: Client;
  backupDir: string;
  keep: number;
}

const BACKUP_FILE_PATTERN = /^chan-backup-\d{4}-\d{2}-\d{2}T\d{6}(-\d+)?Z?\.json$/;

function rowToJson(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
  return out;
}

async function listTables(client: Client): Promise<string[]> {
  const rs = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", args: [] });
  return rs.rows.map((r) => r.name as string);
}

async function pruneOld(backupDir: string, keep: number): Promise<void> {
  const files = (await readdir(backupDir)).filter((f) => BACKUP_FILE_PATTERN.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    await unlink(`${backupDir}/${f}`);
    console.log(`[backup] pruned: ${f}`);
  }
}

/** Runs one full backup; returns the written file path. Never throws past mkdir. */
export async function runJsonBackup({ client, backupDir, keep }: BackupOptions): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const started = Date.now();
  const tables = await listTables(client);
  const dump: Record<string, Record<string, unknown>[]> = {};
  let rows = 0;
  for (const t of tables) {
    const rs = await client.execute({ sql: `SELECT * FROM "${t}"`, args: [] });
    dump[t] = rs.rows.map((r) => rowToJson(r as Record<string, unknown>));
    rows += dump[t].length;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, (c) => (c === ':' ? '' : '-'));
  const file = `${backupDir}/chan-backup-${stamp}.json`;
  const payload = JSON.stringify({ backup_version: 1, created_at: new Date().toISOString(), tables: dump }, null, 1);
  await writeFile(file, payload, 'utf8');
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[backup] ${file} (${tables.length} tables, ${rows} rows, ${seconds}s)`);
  await pruneOld(backupDir, keep);
  return file;
}
