/**
 * CN catalog sync for machines with mainland-friendly egress.
 *
 * SSE/SZSE may block some network egress (WAF 403), in which case the daily
 * pipeline records those four sources as failed. Run this script from a Node
 * host with mainland-friendly egress after the daily cycle starts: it pages
 * through the CN catalogs and stages rows into the same libSQL database. The
 * pipeline picks the sources up as complete and commits as usual.
 *
 * Usage (Windows Task Scheduler / cron, e.g. daily 01:00 Beijing):
 *   node --env-file=.env scripts/sync-cn-catalog.ts
 * Requires TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN for remote Turso).
 * Idempotent: sources already complete today are skipped; a run interrupted
 * mid-source resumes from the recorded page on the next invocation.
 */
import { createClient } from '@libsql/client';
import { D1ResearchStore } from '../server/storage/d1Store.ts';
import { LibSqlDatabase } from '../server/storage/libsqlD1.ts';
import { fetchCatalogPage, type PagedSource } from '../server/catalog/paged.ts';

const SOURCES: { source: PagedSource; label: string }[] = [
  { source: 'sse_main', label: '上交所主板' },
  { source: 'sse_star', label: '科创板' },
  { source: 'szse_stocks', label: '深交所股票' },
  { source: 'szse_etf', label: '深交所ETF' },
];

const PAGE_DELAY_MS = 150;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('需要 TURSO_DATABASE_URL（远程 libsql:// 或本地 file:）');
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
  const store = new D1ResearchStore(new LibSqlDatabase(client), { driver: 'server' });

  const today = new Date().toISOString().slice(0, 10);
  const lastCycle = await store.getAppState('cron:last-cycle-date');
  if (lastCycle !== today) {
    console.log(`今日周期尚未启动（cron:last-cycle-date=${lastCycle ?? '空'}，UTC 今天=${today}），跳过。`);
    return;
  }

  const states = await store.syncState();
  const bySource = new Map(states.map((state) => [state.source, state]));
  const failures: string[] = [];
  let synced = 0;
  for (const { source, label } of SOURCES) {
    const state = bySource.get(source);
    if (state?.status === 'complete') {
      console.log(`${label}：今日已同步（${state.stagedCount} 只），跳过`);
      continue;
    }
    // Resume mid-source only when a previous run of THIS script left it running.
    // A cron 'failed' record starts over (the pipeline never staged anything anyway).
    let cursor = state?.status === 'running' && state.pagesDone > 0 ? String(state.pagesDone) : null;
    let pages = 0;
    let rows = 0;
    const startedAt = Date.now();
    try {
      do {
        const result = await fetchCatalogPage(source, cursor, { fetch: globalThis.fetch, timeoutMs: 20_000 });
        await store.stageCatalogPage(result);
        pages++;
        rows += result.rows.length;
        cursor = result.nextCursor;
        if (cursor !== null) await sleep(PAGE_DELAY_MS);
      } while (cursor !== null);
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(`${label}：${pages} 页 ${rows} 只，用时 ${seconds}s`);
      synced++;
    } catch (error) {
      // One blocked source must not lose the others' work: record the failure
      // honestly (commit stays 未封口 for it) and continue with the rest.
      const message = error instanceof Error ? error.message : '目录同步失败';
      await store.failCatalogSource(source, message);
      failures.push(`${label}：${message}`);
      console.log(`${label}：失败落账（已推进 ${pages} 页 / ${rows} 只）——${message}`);
    }
  }
  if (synced) console.log(`CN 目录同步完成 ${synced} 个来源，定时流水线将在下一 tick 提交目录。`);
  if (failures.length) {
    console.log(`未成功的来源：${failures.join('；')}`);
    console.log('提示：深交所对本机 TLS 握手亦会掐断（IP/指纹级封锁）。换网络（如手机热点）重跑本脚本可续传。');
    process.exitCode = 1;
  } else if (!synced) {
    console.log('没有需要同步的 CN 来源。');
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('CN 目录同步失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
