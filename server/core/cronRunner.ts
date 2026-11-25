import type { ProviderRouter } from './providerRouter.ts';
import type { ResearchStore, SyncSourceState } from '../storage/researchStore.ts';
import { fetchCatalogPage, isPagedSource, type PagedSource } from '../catalog/paged.ts';
import { finalizeRanked, processClaimed } from './scanPipeline.ts';
import type { StoredSignalEvent } from './signalDiff.ts';
import { buildFinalizeNotification, hasNotifier, sendNotification, type NotifyConfig } from './notify.ts';

/** Sources in commit-completeness order (must match d1Store.commitCatalog). */
const SOURCES: string[] = ['sse_main', 'sse_star', 'szse_stocks', 'szse_etf', 'nasdaq_stocks', 'nasdaq_etf', 'hkex'];
const SOURCE_LABELS: Record<string, string> = { sse_main: '上交所主板', sse_star: '科创板', szse_stocks: '深交所股票', szse_etf: '深交所ETF', nasdaq_stocks: '美国股票', nasdaq_etf: '美国ETF', hkex: '港交所' };

export interface CronTickResult {
  action: 'idle' | 'cycle-start' | 'sync' | 'commit' | 'scan' | 'retry' | 'finalize';
  detail: string;
}

export interface CronRunnerOptions {
  store: ResearchStore;
  router: ProviderRouter;
  /** Instruments per scan tick. Small batches keep each tick bounded. */
  batchSize?: number;
  /** Catalog pages advanced per tick during sync. */
  syncPagesPerTick?: number;
  /** UTC hour after which the daily sync+scan cycle may start (set 0 to allow all day). */
  cycleHourUtc?: number;
  /** Skip the daily date gate entirely (verification / manual runs). */
  ignoreDailyGate?: boolean;
  /**
   * Hours after cycle start to wait for an external CN catalog sync (e.g. the
   * Node host running scripts/sync-cn-catalog.ts) before committing a catalog
   * whose CN sources all failed from this egress. 0 disables the wait.
   */
  cnSyncDeadlineHours?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof globalThis.fetch;
  /** Push channels notified once a snapshot publishes (all optional). */
  notify?: NotifyConfig;
}

/**
 * One unit of the daily automated cycle, safe to invoke on a schedule (the
 * Node host timer in server/node/index.ts). Each tick does a bounded slice of
 * work and persists progress, so any tick can crash without losing the run:
 *   daily gate → catalog sync (paged + single-shot sources) → commit →
 *   scan batches (with stale-claim recovery and one retry round) → finalize.
 */
export async function runCronTick(options: CronRunnerOptions): Promise<CronTickResult> {
  const { store, router } = options;
  // One bar fetch takes 1-9s upstream plus retries; small bounded batches keep
  // every tick predictable and let persisted progress resume after a crash.
  const batchSize = Math.min(8, Math.max(1, options.batchSize ?? 4));
  const syncPagesPerTick = Math.max(1, options.syncPagesPerTick ?? 3);
  const cycleHourUtc = options.cycleHourUtc ?? 16;
  const now = options.now ?? (() => new Date());

  // Mirror scheduling config into app_state so /api/pipeline/status can report
  // the live cadence from anywhere (fire-and-forget, tiny rows).
  void store.setAppState('cron:cycle-hour-utc', String(cycleHourUtc)).catch(() => {});
  void store.setAppState('cron:ignore-gate', options.ignoreDailyGate ? '1' : '0').catch(() => {});

  const latest = await store.latestScan();
  if (latest?.status === 'running') {
    const counts = latest.counts;
    if ((counts.pending ?? 0) === 0 && (counts.running ?? 0) === 0) {
      // One retry round per run: transient upstream failures deserve a second
      // pass; permanently broken sources keep their honest failure records.
      if ((counts.failed_terminal ?? 0) > 0 && !(await store.getAppState(`cron:retry:${latest.id}`))) {
        await store.setAppState(`cron:retry:${latest.id}`, '1');
        const retried = await store.retryFailed(latest.id);
        return { action: 'retry', detail: `重试 ${retried} 个失败项（每轮一次）` };
      }
      const scored = await finalizeRanked(store, latest.id);
      const events = await appendSignalEvents(store, latest.id, now);
      // Push once per published snapshot. Awaited but bounded: sendNotification
      // has per-channel
      // timeouts and never throws, so a dead notifier cannot stall finalize.
      if (events && hasNotifier(options.notify)) {
        await sendNotification(options.notify!, buildFinalizeNotification({
          events, scored, total: latest.total, snapshotDate: now().toISOString().slice(0, 10),
        }));
      }
      return { action: 'finalize', detail: `快照封口并发布：${scored} 只评分` };
    }
    const stale = { staleBeforeMs: 10 * 60_000, maxAttempts: 5 };
    // Recover items claimed but never written back: process them in THIS tick
    // (no stale window — the reclaim claim itself refreshes claimed_at, which
    // would otherwise deadlock them into failure).
    const stuck = await store.claimStep(latest.id, Math.min(batchSize, 8), { staleBeforeMs: 0, maxAttempts: 5 });
    if (stuck.length) {
      const results = await processClaimed(router, stuck);
      const next = await store.completeStep(latest.id, results);
      const done = next.total - (next.counts.pending ?? 0) - (next.counts.running ?? 0);
      return { action: 'scan', detail: `回收并重扫 ${results.length} 只（${done}/${next.total}）` };
    }
    const claimed = await store.claimStep(latest.id, batchSize, stale);
    if (!claimed.length) return { action: 'scan', detail: '无可领取项（等待陈旧回收）' };
    const results = await processClaimed(router, claimed);
    const next = await store.completeStep(latest.id, results);
    const done = next.total - (next.counts.pending ?? 0) - (next.counts.running ?? 0);
    return { action: 'scan', detail: `推进 ${results.length} 只（${done}/${next.total}）` };
  }

  const current = now();
  const today = current.toISOString().slice(0, 10);
  const lastCycle = await store.getAppState('cron:last-cycle-date');

  // Daily gate first: once per day restart the cycle. ignoreDailyGate only
  // lifts the hour window (for live verification), never the once-per-day
  // check — otherwise every tick would reset the cycle from scratch. If a
  // previous cycle died between ticks, its leftover ledger is discarded.
  // Advancing starts in the same tick so an empty ledger is never ambiguous.
  if (lastCycle !== today && (options.ignoreDailyGate || current.getUTCHours() >= cycleHourUtc)) {
    await store.setAppState('cron:last-cycle-date', today);
    await store.setAppState('cron:cycle-start', current.toISOString());
    await store.resetSync();
    const started = await advanceSync(store, [], syncPagesPerTick, options.fetchImpl ?? globalThis.fetch, now);
    return { action: 'sync', detail: `每日周期启动：${started.detail}` };
  }

  const states = await store.syncState();
  if (states.length) {
    // Every expected source must be present AND terminal before committing —
    // sources absent from the ledger simply haven't started yet.
    const bySource = new Map(states.map((state) => [state.source, state]));
    const allTerminal = SOURCES.every((source) => {
      const state = bySource.get(source);
      return !!state && (state.status === 'complete' || state.status === 'failed');
    });
    if (!allTerminal) return advanceSync(store, states, syncPagesPerTick, options.fetchImpl ?? globalThis.fetch, now);
    // Wait for an external CN sync (scripts/sync-cn-catalog.ts on a mainland
    // host) when this egress could not reach SSE/SZSE. Holding the commit lets
    // the CN rows land so the catalog is complete; past the deadline we commit
    // whatever we have and the snapshot stays honestly "未封口".
    const cnSources = ['sse_main', 'sse_star', 'szse_stocks', 'szse_etf'];
    const cnMissing = cnSources.some((source) => bySource.get(source)?.status !== 'complete');
    const deadlineHours = Math.max(0, options.cnSyncDeadlineHours ?? 0);
    if (cnMissing && deadlineHours > 0) {
      // A cycle started by an older build has no start marker: never wait on it.
      const startedAt = await store.getAppState('cron:cycle-start');
      const waited = startedAt ? (current.getTime() - new Date(startedAt).getTime()) / 3_600_000 : deadlineHours + 1;
      if (waited < deadlineHours) {
        return { action: 'idle', detail: `等待外部 CN 目录同步（已等 ${waited.toFixed(1)}h / ${deadlineHours}h）` };
      }
    }
    let commit: Awaited<ReturnType<ResearchStore['commitCatalog']>>;
    try {
      commit = await store.commitCatalog();
    } catch (error) {
      // Every source failed and nothing was staged: keep the ledger so the
      // retry counters still apply, and wait for tomorrow's cycle.
      const message = error instanceof Error ? error.message.slice(0, 120) : '目录提交失败';
      return { action: 'idle', detail: `目录提交失败（所有来源均未入库）：${message}` };
    }
    const run = await store.createScan(commit.version);
    return { action: 'commit', detail: `目录 ${commit.total} 只（${commit.complete ? '封口' : '未封口'}），扫描已启动 ${run.id.slice(0, 8)}` };
  }

  return { action: 'idle', detail: '今日周期已完成' };
}

/** After publishing snapshot N, diff its scores against snapshot N-1 into signal_events. Returns the new events (null on failure). */
async function appendSignalEvents(store: ResearchStore, runId: string, now: () => Date): Promise<StoredSignalEvent[] | null> {
  try {
    const history = await store.snapshotHistory(3);
    const currentIndex = history.findIndex((item) => item.id === runId);
    const previousId = currentIndex >= 0 && currentIndex + 1 < history.length ? history[currentIndex + 1].id : null;
    const loadScores = async (snapshotId: string) => {
      const rows: { instrumentId: string; name: string; market: string; kind: string; momentumScore: number; resonance: number; quadrant: string; rank: number }[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.rankingsPage({ snapshotId, limit: 200, cursor });
        for (const item of page.items) {
          rows.push({ instrumentId: item.instrument.id, name: item.instrument.name, market: item.instrument.market, kind: item.instrument.kind, momentumScore: item.momentumScore ?? 0, resonance: item.resonance ?? 0, quadrant: String(item.quadrant ?? ''), rank: item.rank ?? 0 });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return rows;
    };
    const currentScores = await loadScores(runId);
    const prevScores = previousId ? await loadScores(previousId) : null;
    const { diffSnapshotSignals } = await import('./signalDiff.ts');
    const events = diffSnapshotSignals(runId, previousId, prevScores as never, currentScores as never, now());
    if (events.length) {
      const { saveSignalEvents } = await import('../storage/signalStore.ts');
      await saveSignalEvents(store, events);
    }
    return events;
  } catch (error) {
    // Signals are additive; a diff failure must never fail the finalize action.
    console.error('[cron] signal diff failed', error);
    return null;
  }
}

async function advanceSync(
  store: ResearchStore,
  states: SyncSourceState[],
  budget: number,
  fetchImpl: typeof globalThis.fetch,
  now: () => Date,
): Promise<CronTickResult> {
  const bySource = new Map(states.map((state) => [state.source, state]));
  const details: string[] = [];
  for (const source of SOURCES) {
    if (budget <= 0) break;
    const state = bySource.get(source);
    if (state?.status === 'complete') continue;
    if (state?.status === 'failed') {
      // Retry failed sources up to twice per cycle before giving up for the day.
      const key = `cron:sync-retry:${source}:${now().toISOString().slice(0, 10)}`;
      const attempts = Number(await store.getAppState(key) ?? '0');
      if (attempts >= 2) continue;
      await store.setAppState(key, String(attempts + 1));
    }
    if (isPagedSource(source)) {
      for (let page = 0; page < budget; page++) {
        const cursor = String(bySource.get(source)?.pagesDone ?? 0);
        try {
          const result = await fetchCatalogPage(source as PagedSource, cursor, { fetch: fetchImpl, timeoutMs: 20_000 });
          const updated = await store.stageCatalogPage(result);
          details.push(`${SOURCE_LABELS[source]} 第 ${updated.pagesDone} 页 +${result.rows.length}`);
          if (result.nextCursor === null) break;
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 120) : '目录分页失败';
          const failed = await store.failCatalogSource(source, message);
          details.push(`${SOURCE_LABELS[source]} 失败落账：${message}（第 ${failed.pagesDone} 页）`);
          break;
        }
      }
      budget -= 1;
      continue;
    }
    if (source === 'nasdaq_stocks' || source === 'nasdaq_etf') {
      try {
        const kind = source === 'nasdaq_etf' ? 'etf' : 'stocks';
        const upstream = await fetchImpl(`https://api.nasdaq.com/api/screener/${kind}?tableonly=true&limit=25&offset=0&download=true`, {
          headers: { accept: 'application/json', 'user-agent': 'ChanDashboard/1.0' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!upstream.ok) throw new Error(`Nasdaq目录HTTP ${upstream.status}`);
        const { parseNasdaqScreener } = await import('../../shared/nasdaqScreener.ts');
        const parsed = parseNasdaqScreener(kind, await upstream.json());
        await store.stageCatalogRows(source, parsed.instruments, { declaredTotal: parsed.declaredTotal, pageCount: 1, done: true });
        details.push(`${SOURCE_LABELS[source]} 全量 ${parsed.instruments.length} 只`);
        budget -= 1;
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 120) : 'Nasdaq目录失败';
        await store.failCatalogSource(source, message);
        details.push(`${SOURCE_LABELS[source]} 失败落账：${message}`);
        budget -= 1;
      }
      continue;
    }
    if (source === 'hkex') {
      budget -= 1;
      try {
        const upstream = await fetchImpl('https://www.hkex.com.hk/eng/services/trading/securities/securitieslists/ListOfSecurities.xlsx', { signal: AbortSignal.timeout(20_000) });
        if (!upstream.ok) throw new Error(`港交所目录HTTP ${upstream.status}`);
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(await upstream.arrayBuffer(), { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
        const { parseHkexWorkbookRows } = await import('../../shared/hkexWorkbook.ts');
        const instruments = parseHkexWorkbookRows(rows);
        if (instruments.length < 1000) throw new Error(`港交所工作簿疑似样本文件（仅 ${instruments.length} 只）`);
        await store.stageCatalogRows('hkex', instruments, { declaredTotal: instruments.length, pageCount: 1, done: true, sourceDate: rows[1] ? String(rows[1][0] ?? '') : null });
        details.push(`港交所全量 ${instruments.length} 只`);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 120) : '港交所目录失败';
        await store.failCatalogSource('hkex', message);
        details.push(`港交所失败落账：${message}`);
      }
    }
  }
  return { action: 'sync', detail: details.length ? details.join('；') : '本轮无目录推进（来源失败重试额度用尽）' };
}
