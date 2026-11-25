/**
 * Manual / external-scheduler JSON backup of the whole libSQL database.
 *
 * Usage: node --env-file-if-exists=.env scripts/backup-db.ts [backup-dir]
 *   env: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN / BACKUP_KEEP (default 14)
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@libsql/client';
import { runJsonBackup } from '../server/core/backup.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.TURSO_DATABASE_URL;
if (!url) { console.error('未配置 TURSO_DATABASE_URL，无法备份'); process.exit(1); }

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
const file = await runJsonBackup({
  client,
  backupDir: resolve(root, process.argv[2] ?? 'backups'),
  keep: Math.max(1, Number(process.env.BACKUP_KEEP) || 14),
});
console.log(`done: ${file}`);
