import { describe, expect, it } from 'vitest';
import { MemoryResearchStore } from '../server/storage/researchStore';
import type { ProviderRouter } from '../server/core/providerRouter';
import { runCronTick } from '../server/core/cronRunner';
import { finalizeRanked } from '../server/core/scanPipeline';
import type { Candle } from '../shared/market';

function candles(count = 150): Candle[] {
  return Array.from({ length: count }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), open: 100 + i, close: 101 + i, high: 103 + i, low: 99 + i, volume: 1000 + i }));
}

const marketData = { candles: candles(), provider: 'test', adjustment: 'none', sourceDate: '2026-11-20', receivedAt: '2026-11-20T00:00:00Z', cache: 'miss', stale: false, isUnclosed: false, attempts: [] } as never;

function fakeRouter(): ProviderRouter {
  return { getDaily: async () => marketData } as unknown as ProviderRouter;
}

const sseMainPage = { pageHelp: { total: 2 }, result: [{ SECURITY_CODE_A: '600000', SECURITY_ABBR_A: '浦发银行', LISTING_DATE: '1999-11-10' }, { SECURITY_CODE_A: '600519', SECURITY_ABBR_A: '贵州茅台', LISTING_DATE: '2001-08-27' }] };
const sseStarPage = { pageHelp: { total: 2 }, result: [{ SECURITY_CODE_A: '688001', SECURITY_ABBR_A: '华兴源创', LISTING_DATE: '2019-07-22' }, { SECURITY_CODE_A: '688981', SECURITY_ABBR_A: '中芯国际', LISTING_DATE: '2020-07-16' }] };
const szseStocksPage = [{ metadata: { tabkey: 'tab1', recordcount: '2', pagecount: '1' }, data: [{ agdm: '000001', agjc: '平安银行', agssrq: '1991-04-03' }, { agdm: '000002', agjc: '万科A', agssrq: '1991-01-29' }] }];
const szseEtfPage = [{ metadata: { tabkey: 'tab1', recordcount: '1', pagecount: '1' }, data: [{ sys_key: '159915', jjjcurl: '创业板ETF', ssrq: '2011-12-09', jjlb: 'ETF' }] }];
const nasdaqStocks = { data: { rows: [{ symbol: 'AAPL', name: 'Apple Inc.' }, { symbol: 'MSFT', name: 'Microsoft Corporation' }] } };
const nasdaqEtf = { data: { data: { rows: [{ symbol: 'QQQ', companyName: 'Invesco QQQ Trust' }] } } };

function fakeFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input instanceof URL ? input : (input as { url?: string; toString(): string }));
    const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;
    if (url.includes('query.sse.com.cn')) return json(url.includes('stockType=8') ? sseStarPage : sseMainPage);
    if (url.includes('www.szse.cn')) return json(url.includes('CATALOGID=1105') ? szseEtfPage : szseStocksPage);
    if (url.includes('api.nasdaq.com')) return json(url.includes('/screener/etf') ? nasdaqEtf : nasdaqStocks);
    return { ok: false, status: 403 } as unknown as Response;
  }) as typeof fetch;
}

function tick(store: MemoryResearchStore, now = new Date('2026-11-20T17:30:00Z')) {
  return runCronTick({ store, router: fakeRouter(), fetchImpl: fakeFetch(), now: () => now, batchSize: 16, cycleHourUtc: 16 });
}

describe('cron runner daily cycle', () => {
  it('starts the cycle after the configured UTC hour and idles after finishing it', async () => {
    const store = new MemoryResearchStore();
    expect((await tick(store, new Date('2026-11-20T05:00:00Z'))).action).toBe('idle');
    const started = await tick(store);
    expect(started.action).toBe('sync');
    expect(started.detail).toContain('每日周期启动');
  });

  it('advances sync pages, commits, scans, retries nothing, and finalizes', async () => {
    const store = new MemoryResearchStore();
    const first = await tick(store);
    expect(first.detail).toContain('每日周期启动');
    // Sync ticks until every source is terminal (hkex fails honestly → 未封口).
    for (let i = 0; i < 8; i++) {
      const result = await tick(store);
      if (result.action === 'commit') {
        expect(result.detail).toContain('未封口');
        break;
      }
      expect(result.action).toBe('sync');
    }
    // Scan ticks: reclaim and rescan in one pass now, so a small catalog
    // finishes within the loop; the last tick may already finalize.
    let sawScan = false;
    for (let i = 0; i < 12; i++) {
      const tickResult = await tick(store);
      if (tickResult.action === 'scan') sawScan = true;
      if (tickResult.action === 'finalize') break;
    }
    expect(sawScan).toBe(true);
    const latest = await store.latestScan();
    expect(latest?.status).toBe('completed');
    expect(latest?.counts.pending).toBe(0);
    expect(latest?.counts.running).toBe(0);
    // The scan finished (and likely finalized) inside the loop above.
    const brief = await store.researchBrief();
    expect(brief).not.toBeNull();
    expect(brief?.total).toBe(10);
    expect(brief?.ready).toBe(10);
    // Afterwards the daily cycle is done for today.
    expect((await tick(store)).action).toBe('idle');
  });

  it('waits for an external CN sync before committing when CN sources failed', async () => {
    const store = new MemoryResearchStore();
    // Egress where SSE/SZSE are blocked, Nasdaq reachable, HKEX fails.
    const cnBlockedFetch = (async (input: unknown) => {
      const url = String(input instanceof URL ? input : (input as { url?: string; toString(): string }));
      const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response;
      if (url.includes('query.sse.com.cn') || url.includes('www.szse.cn')) return { ok: false, status: 403 } as unknown as Response;
      if (url.includes('api.nasdaq.com')) return json(url.includes('/screener/etf') ? nasdaqEtf : nasdaqStocks);
      return { ok: false, status: 403 } as unknown as Response;
    }) as typeof fetch;
    const tickWith = (now: Date) => runCronTick({ store, router: fakeRouter(), fetchImpl: cnBlockedFetch, now: () => now, batchSize: 16, cycleHourUtc: 16, ignoreDailyGate: true, cnSyncDeadlineHours: 3 });
    const t0 = new Date('2026-11-20T17:30:00Z');
    await tickWith(t0); // cycle-start
    let waited = false;
    for (let i = 0; i < 10; i++) {
      const result = await tickWith(new Date(t0.getTime() + 60_000));
      if (result.action === 'idle' && result.detail.includes('等待外部 CN')) { waited = true; break; }
    }
    expect(waited).toBe(true);
    // No scan started while the commit is held.
    expect(await store.latestScan()).toBeNull();
    // Past the deadline the same ledger commits (honestly 未封口).
    const after = new Date(t0.getTime() + 4 * 3_600_000);
    let committed = false;
    for (let i = 0; i < 3; i++) {
      const result = await tickWith(after);
      if (result.action === 'commit') { committed = true; expect(result.detail).toContain('未封口'); break; }
    }
    expect(committed).toBe(true);
  });

  it('retries failed_terminal once per run before finalizing', async () => {
    const store = new MemoryResearchStore();
    await store.publishCatalog({ version: 'v1', createdAt: '2026-11-20T00:00:00Z', complete: true, instruments: [{ id: 'US:AAPL', symbol: 'AAPL', name: 'Apple', market: 'US', kind: 'stock', currency: 'USD', providers: { nasdaq: 'AAPL' }, listingStatus: 'listed', listedAt: null, exchange: 'US_MAIN', catalogSource: 'nasdaq', catalogVersion: 'v1', mappingStatus: 'ready' }], sources: [] });
    const run = await store.createScan('v1');
    await store.claimStep(run.id, 5);
    const failing = new MemoryResearchStore();
    // Simulate a provider outage via a router that throws, then recover.
    const brokenRouter = { getDaily: async () => { throw new Error('上游断连'); } } as unknown as ProviderRouter;
    void failing;
    await store.completeStep(run.id, [{ instrumentId: 'US:AAPL', status: 'failed_terminal', lastError: '上游断连', record: null }]);
    // First tick: retry gate.
    const retryTick = await runCronTick({ store, router: brokenRouter, now: () => new Date('2026-11-20T17:30:00Z'), cycleHourUtc: 16 });
    expect(retryTick.action).toBe('retry');
    // Ticks: reclaim+rescan in one pass, so the single-item run may finalize
    // on the very next tick.
    const scanTick = await runCronTick({ store, router: fakeRouter(), now: () => new Date('2026-11-20T17:31:00Z'), cycleHourUtc: 16 });
    expect(scanTick.action).toBe('scan');
    const finalizeTick = await runCronTick({ store, router: fakeRouter(), now: () => new Date('2026-11-20T17:31:30Z'), cycleHourUtc: 16 });
    expect(finalizeTick.action).toBe('finalize');
    expect((await store.researchBrief())?.ready).toBe(1);
    // Retry marker prevents a second retry round on the next cycle's runs only per-run.
    expect(await store.getAppState(`cron:retry:${run.id}`)).toBe('1');
  });

  it('reclaims stale running items and fails them past max attempts', async () => {
    const store = new MemoryResearchStore();
    await store.publishCatalog({ version: 'v1', createdAt: '2026-11-20T00:00:00Z', complete: true, instruments: [{ id: 'US:AAPL', symbol: 'AAPL', name: 'Apple', market: 'US', kind: 'stock', currency: 'USD', providers: { nasdaq: 'AAPL' }, listingStatus: 'listed', listedAt: null, exchange: 'US_MAIN', catalogSource: 'nasdaq', catalogVersion: 'v1', mappingStatus: 'ready' }], sources: [] });
    const run = await store.createScan('v1');
    await store.claimStep(run.id, 5);
    // Stale recovery with maxAttempts=1: the abandoned running item becomes terminal.
    await store.claimStep(run.id, 5, { staleBeforeMs: 0, maxAttempts: 1 });
    const summary = await store.scanSummary(run.id);
    expect(summary?.counts.failed_terminal).toBe(1);
    expect(summary?.counts.running).toBe(0);
  });

  it('rotates published snapshots to the retention window', async () => {
    const store = new MemoryResearchStore();
    await store.publishCatalog({ version: 'v1', createdAt: '2026-11-20T00:00:00Z', complete: true, instruments: [{ id: 'US:AAPL', symbol: 'AAPL', name: 'Apple', market: 'US', kind: 'stock', currency: 'USD', providers: { nasdaq: 'AAPL' }, listingStatus: 'listed', listedAt: null, exchange: 'US_MAIN', catalogSource: 'nasdaq', catalogVersion: 'v1', mappingStatus: 'ready' }], sources: [] });
    const { computeAsset } = await import('../src/domain/resonance');
    const asset = computeAsset(candles())!;
    for (let i = 0; i < 32; i++) {
      const run = await store.createScan('v1');
      await store.claimStep(run.id, 5);
      await store.completeStep(run.id, [{ instrumentId: 'US:AAPL', status: 'succeeded', lastError: null, record: { instrument: { id: 'US:AAPL', symbol: 'AAPL', name: 'Apple', market: 'US', kind: 'stock', currency: 'USD', providers: {} }, status: 'ready', chanScore: null, momentumScore: null, resonance: null, quadrant: null, rank: null, rankDelta: null, chan: asset.chan, momentum: asset.momentum, snapshot: { provider: 'nasdaq', interval: '1d', adjustment: 'split', sourceDate: '2026-11-20', receivedAt: '2026-11-20T00:00:00Z', cache: 'miss', stale: false, isUnclosed: false, attempts: [], candleCount: 150 }, attempts: [], error: null } }]);
      await finalizeRanked(store, run.id);
    }
    const history = await store.snapshotHistory();
    expect(history).toHaveLength(30);
    expect(await store.researchBrief()).not.toBeNull();
    const points = await store.trendPoints({ ids: ['US:AAPL'], limit: 30 });
    expect(points.length).toBe(30);
    expect(points[0].createdAt! <= points[points.length - 1].createdAt!).toBe(true);
  });
});
