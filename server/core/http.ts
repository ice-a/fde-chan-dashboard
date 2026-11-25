import { INSTRUMENT_MAP } from '../../src/config/instruments.ts';
import type { MarketFailure } from '../../shared/market.ts';
import type { ProviderAttempt } from '../../shared/market.ts';
import { eastmoneyProvider } from './providers/eastmoney.ts';
import { tencentProvider } from './providers/tencent.ts';
import { nasdaqProvider } from './providers/nasdaq.ts';
import { ProviderRouter } from './providerRouter.ts';
import { createDefaultResearchStore } from '../storage/researchStore.ts';
import type { ResearchStore, RankQuery } from '../storage/researchStore.ts';
import { fetchCatalogPage, isPagedSource, type PagedSource } from '../catalog/paged.ts';
import { finalizeRanked, processClaimed } from './scanPipeline.ts';
import { listSignalEvents, signalStoreFrom } from '../storage/signalStore.ts';
import { buildPipelineStatus } from './pipelineStatus.ts';
import { sendNotification, type NotifyConfig } from './notify.ts';

export interface ResearchHandlerOptions {
  store?: ResearchStore;
  adminToken?: string;
  catalogTimeoutMs?: number;
  /** Auto-run scans in-process (Node server driver). The 'client' driver uses the dashboard-driven pipeline instead. */
  backgroundScan?: boolean;
  /** Push channels for the daily snapshot notification (optional). */
  notify?: NotifyConfig;
}

export function createResearchHandler(router: ProviderRouter, options: ResearchHandlerOptions = {}) {
  const store = options.store ?? createDefaultResearchStore();
  const adminToken = options.adminToken ?? process.env.RESEARCH_ADMIN_TOKEN;
  const catalogTimeoutMs = options.catalogTimeoutMs ?? (Number(process.env.RESEARCH_CATALOG_TIMEOUT_MS) || 45000);
  const backgroundScan = options.backgroundScan ?? store.driver === 'server';
  const active = new Set<string>();

  return async function handleResearch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const url = new URL(request.url);
    const path = url.pathname;
    const body = request.method === 'POST' ? await safeJson(request) : null;

    // ----- Catalog -----
    if (path === '/api/catalog/summary') {
      return json({ ok: true, summary: await store.catalogSummary(), latestScan: await store.latestScan(), research: await store.researchBrief(), driver: store.driver });
    }
    if (path === '/api/catalog/instruments') {
      const page = await store.listCatalog({ market: url.searchParams.get('market') ?? undefined, q: url.searchParams.get('q') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined, limit: Number(url.searchParams.get('limit')) || 50 });
      return json({ ok: true, page });
    }
    if (path === '/api/catalog/sync-state') {
      const states = await store.syncState();
      return json({ ok: true, states });
    }
    if (path === '/api/catalog/sync' && request.method === 'POST') {
      if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
      if (store.driver === 'client') {
        if (body?.reset !== false) await store.resetSync();
        return json({ ok: true, mode: 'paged' as const, driver: store.driver });
      }
      const { syncCatalog } = await import('../catalog/sync.ts');
      const { sseCatalog } = await import('../catalog/sse.ts');
      const { szseCatalog } = await import('../catalog/szse.ts');
      const { nasdaqCatalog } = await import('../catalog/nasdaq.ts');
      const { hkexCatalog } = await import('../catalog/hkex.ts');
      const snapshot = await syncCatalog([sseCatalog, szseCatalog, hkexCatalog, nasdaqCatalog], { fetch: (input, init) => globalThis.fetch(input, init), timeoutMs: catalogTimeoutMs });
      await store.publishCatalog(snapshot);
      return json({ ok: true, snapshot: { version: snapshot.version, complete: snapshot.complete, total: snapshot.instruments.length, sources: snapshot.sources } });
    }
    if (path === '/api/catalog/sync/page' && request.method === 'POST') {
      if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
      const source = String(body?.source ?? '');
      const cursor = body?.cursor == null ? null : String(body.cursor);
      if (!isPagedSource(source)) return json({ error: '不支持的分页目录来源' }, 400);
      try {
        const result = await fetchCatalogPage(source as PagedSource, cursor, { fetch: (input, init) => globalThis.fetch(input, init), timeoutMs: Math.min(catalogTimeoutMs, 20_000), signal: request.signal });
        const state = await store.stageCatalogPage(result);
        return json({ ok: true, state, nextCursor: result.nextCursor });
      } catch (error) {
        const message = error instanceof Error ? error.message : '目录分页获取失败';
        // Persist the failure so the source reports honestly and commit stays incomplete.
        const state = await store.failCatalogSource(source, message);
        return json({ ok: false, error: message, state }, 502);
      }
    }
    if (path === '/api/catalog/sync-fail' && request.method === 'POST') {
      if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
      const source = String(body?.source ?? '');
      if (!source || source.length > 40) return json({ error: '来源无效' }, 400);
      const state = await store.failCatalogSource(source, String(body?.error ?? '目录同步失败'));
      return json({ ok: true, state });
    }
    if (path === '/api/catalog/hkex-workbook') {
      try {
        const upstream = await fetch('https://www.hkex.com.hk/eng/services/trading/securities/securitieslists/ListOfSecurities.xlsx', { signal: AbortSignal.timeout(catalogTimeoutMs) });
        if (!upstream.ok || !upstream.body) return json({ error: `港交所目录HTTP ${upstream.status}` }, 502);
        return new Response(upstream.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : '港交所目录获取失败' }, 502);
      }
    }
    if (path === '/api/catalog/nasdaq-screener') {
      // The paged screener order is non-deterministic, so catalog sync uses the
      // single-shot download=true payload, proxied unparsed (the browser parses
      // it for the dashboard-driven pipeline). Fixed host and path: not an open proxy.
      const kind = url.searchParams.get('kind') === 'etf' ? 'etf' : 'stocks';
      try {
        const upstream = await fetch(`https://api.nasdaq.com/api/screener/${kind}?tableonly=true&limit=25&offset=0&download=true`, {
          headers: { accept: 'application/json', 'user-agent': 'ChanDashboard/1.0' },
          signal: AbortSignal.timeout(catalogTimeoutMs),
        });
        if (!upstream.ok || !upstream.body) return json({ error: `Nasdaq目录HTTP ${upstream.status}` }, 502);
        return new Response(upstream.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Nasdaq目录获取失败' }, 502);
      }
    }
    if (path === '/api/catalog/stage' && request.method === 'POST') {
      if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
      const rows = Array.isArray(body?.rows) ? body!.rows as never[] : [];
      if (rows.length > 1000) return json({ error: '单次暂存不能超过 1000 行' }, 400);
      try {
        const state = await store.stageCatalogRows('hkex', rows, { declaredTotal: Number(body?.declaredTotal) || undefined, pageCount: Number(body?.pageCount) || 1, done: body?.done === true, sourceDate: body?.sourceDate ? String(body.sourceDate) : null });
        return json({ ok: true, state });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : '目录暂存失败' }, 502);
      }
    }
    if (path === '/api/catalog/commit' && request.method === 'POST') {
      if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
      try { return json({ ok: true, ...(await store.commitCatalog()) }); }
      catch (error) { return json({ error: error instanceof Error ? error.message : '目录提交失败' }, 409); }
    }

    // ----- Scan: create / status -----
    if (path === '/api/scans' && request.method === 'POST') {
      if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
      const existing = await store.latestScan();
      if (existing?.status === 'running' && body?.force !== true) return json({ ok: true, running: true, scan: existing, driver: store.driver, note: '已有扫描进行中' });
      const version = await store.currentCatalogVersion();
      if (!version) return json({ error: '尚未同步目录' }, 409);
      const ids = Array.isArray(body?.instrumentIds) ? (body!.instrumentIds as string[]) : undefined;
      try {
        const run = await store.createScan(version, ids);
        if (backgroundScan && !active.has(run.id)) {
          active.add(run.id);
          void backgroundRun(run.id).finally(() => active.delete(run.id));
        }
        return json({ ok: true, scan: run, driver: store.driver });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : '扫描创建失败' }, 409);
      }
    }

    const scanMatch = path.match(/^\/api\/scans\/([^/]+)(\/step|\/raws|\/scores|\/finalize|\/retry)?$/);
    if (scanMatch) {
      const scanId = decodeURIComponent(scanMatch[1]);
      const action = scanMatch[2];
      const run = await store.scanSummary(scanId);
      if (!run) return json({ error: '扫描任务不存在' }, 404);

      if (!action) return json({ ok: true, scan: run, driver: store.driver });

      if (action === '/step' && request.method === 'POST') {
        if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
        const limit = Math.min(10, Math.max(1, Number(body?.limit) || 6));
        if (run.status !== 'running') return json({ ok: true, scan: run });
        const claimed = await store.claimStep(scanId, limit);
        const results = await processClaimed(router, claimed);
        const next = await store.completeStep(scanId, results);
        return json({ ok: true, scan: next, processed: results.length });
      }
      if (action === '/raws') {
        const page = await store.rawsPage(scanId, Number(url.searchParams.get('cursor')) || 0, Number(url.searchParams.get('limit')) || 3000);
        return json({ ok: true, page });
      }
      if (action === '/scores' && request.method === 'POST') {
        if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
        const scores = Array.isArray(body?.scores) ? (body!.scores as never[]) : [];
        if (scores.length > 500) return json({ error: '单次回写不能超过 500 条评分' }, 400);
        await store.saveScores(scanId, scores);
        return json({ ok: true, saved: scores.length });
      }
      if (action === '/finalize' && request.method === 'POST') {
        if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
        try {
          const brief = await store.finalizeScan(scanId);
          return json({ ok: true, research: brief, scan: await store.scanSummary(scanId) });
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : '快照封口失败' }, 409);
        }
      }
      if (action === '/retry' && request.method === 'POST') {
        if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
        const retried = await store.retryFailed(scanId);
        if (backgroundScan && retried && !active.has(scanId)) { active.add(scanId); void backgroundRun(scanId).finally(() => active.delete(scanId)); }
        return json({ ok: true, retried, scan: await store.scanSummary(scanId) });
      }
    }

    // ----- Published snapshot reads -----
    if (path === '/api/pipeline/status') {
      return json({ ok: true, status: await buildPipelineStatus(store) });
    }
    if (path === '/api/pipeline/test-notify' && request.method === 'POST') {
      if (!checkAdmin(request, adminToken)) return json({ error: '需要管理员令牌' }, 401);
      if (!options.notify || !(options.notify.barkUrl || options.notify.ntfyUrl || options.notify.webhookUrl)) {
        return json({ ok: false, error: '未配置推送渠道（NOTIFY_BARK_URL / NOTIFY_NTFY_URL / NOTIFY_WEBHOOK_URL）' }, 400);
      }
      const results = await sendNotification(options.notify, {
        title: '缠论看板 · 测试推送', body: '如果你看到这条消息，每日快照发布通知已接通。', group: 'chan-dashboard',
      });
      // Success = at least one configured channel answered 2xx.
      const delivered = results.some((item) => /:2\d\d$/.test(item));
      return json({ ok: delivered, results }, delivered ? 200 : 502);
    }
    if (path === '/api/snapshots/list') {
      const limit = Math.min(90, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      return json({ ok: true, snapshots: await store.snapshotHistory(limit) });
    }
    if (path === '/api/snapshots/trends') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 300);
      if (!ids.length) return json({ ok: true, points: [] });
      const limit = Math.min(90, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      return json({ ok: true, points: await store.trendPoints({ ids, limit }) });
    }
    if (path === '/api/snapshots/signals') {
      const db = signalStoreFrom(store);
      if (!db) return json({ ok: true, events: [], note: '当前驱动不支持服务端信号' });
      const events = await listSignalEvents(db, {
        market: url.searchParams.get('market') ?? undefined,
        type: url.searchParams.get('type') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
        limit: Number(url.searchParams.get('limit')) || 100,
      });
      return json({ ok: true, events });
    }
    if (path === '/api/snapshots/current') {
      const brief = await store.researchBrief();
      if (!brief) return json({ ok: true, snapshot: null, note: '尚未发布研究快照' });
      return json({ ok: true, snapshot: { id: brief.id, catalogVersion: brief.catalogVersion, createdAt: brief.createdAt, complete: brief.complete, total: brief.total }, summary: brief });
    }
    const rankingMatch = path.match(/^\/api\/snapshots\/([^/]+)\/rankings$/);
    if (rankingMatch || path === '/api/snapshots/current/rankings') {
      const brief = await store.researchBrief();
      if (!brief) return json({ ok: false, error: { code: 'no_snapshot', message: '尚未发布研究快照' } }, 404);
      // Resolve the "current" alias to the real snapshot id so both drivers can filter by it.
      const snapshotId = rankingMatch && rankingMatch[1] !== 'current' ? decodeURIComponent(rankingMatch[1]) : brief.id;
      const page = await store.rankingsPage(rankingQuery(url, snapshotId));
      return json({ ok: true, page });
    }
    const summaryOrDiagMatch = path.match(/^\/api\/snapshots\/([^/]+)\/(summary|diagnostics)$/);
    if (summaryOrDiagMatch) {
      const brief = await store.researchBrief();
      if (!brief) return json({ error: '尚未发布研究快照' }, 404);
      if (summaryOrDiagMatch[2] === 'summary') return json({ ok: true, summary: brief });
      const snapshotId = summaryOrDiagMatch[1] === 'current' ? brief.id : decodeURIComponent(summaryOrDiagMatch[1]);
      const page = await store.diagnosticsPage({ snapshotId, status: url.searchParams.get('status') ?? undefined, q: url.searchParams.get('q') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined, limit: Number(url.searchParams.get('limit')) || 50 });
      return json({ ok: true, page });
    }
    const detailMatch = path.match(/^\/api\/snapshots\/[^/]+\/instruments\/([^/]+)(\/detail)?$/);
    if (detailMatch) {
      const instrumentId = decodeURIComponent(detailMatch[1]);
      if (detailMatch[3]) return await computeDetail(router, instrumentId, store);
      const page = await store.rankingsPage({ ids: [instrumentId], limit: 1 });
      if (page.items.length) return json({ ok: true, record: page.items[0] });
      const brief = await store.researchBrief();
      if (!brief) return json({ error: '尚未发布研究快照' }, 404);
      const diagnostics = await store.diagnosticsPage({ q: instrumentId, limit: 50 });
      const diagnostic = diagnostics.items.find((item) => item.instrumentId === instrumentId);
      if (diagnostic) return json({ ok: true, record: { instrument: { id: instrumentId }, status: 'unavailable' as const, diagnostic }, note: '该标的本轮无有效评分' });
      return json({ error: '标的不在本轮快照中' }, 404);
    }
    return json({ error: 'Not found' }, 404);
  };

  /** Node-only: drive a scan to completion in-process (steps, ranking, finalize). */
  async function backgroundRun(scanId: string): Promise<void> {
    try {
      for (let guard = 0; guard < 100_000; guard++) {
        const current = await store.scanSummary(scanId);
        if (!current || current.status !== 'running') return;
        if (current.counts.pending === 0 && current.counts.running === 0) break;
        const claimed = await store.claimStep(scanId, 8);
        if (!claimed.length) continue;
        await store.completeStep(scanId, await processClaimed(router, claimed));
      }
      const run = await store.scanSummary(scanId);
      if (!run || run.status !== 'running') return;
      await finalizeRanked(store, scanId);
    } catch (error) {
      console.error('background scan left resumable', error);
    }
  }
}

/** Compute a full instrument detail on demand (no persisted candles needed). */
async function computeDetail(router: ProviderRouter, instrumentId: string, store: ResearchStore): Promise<Response> {
  const instrument = await store.findInstrument(instrumentId) ?? INSTRUMENT_MAP.get(instrumentId);
  if (!instrument) return json({ error: '标的不在受支持的目录中' }, 404);
  try {
    const data = await router.getDaily(instrument);
    if (data.candles.length < 130) return json({ error: `有效日线${data.candles.length}根，不足130根` }, 404);
    const { computeAsset } = await import('../../src/domain/resonance.ts');
    const asset = computeAsset(data.candles);
    if (!asset) return json({ error: '结构计算数据不足' }, 404);
    const { candles: _candles, instrument: _instrument, ...metadata } = data;
    return json({ ok: true, detail: { candles: data.candles, structure: asset.structure, snapshot: { ...metadata, candleCount: data.candles.length } } });
  } catch (error) {
    if (error instanceof Error && /日线|结构/.test(error.message)) return json({ error: error.message }, 404);
    const attempts = (error as Error & { attempts?: ProviderAttempt[] }).attempts ?? [];
    return json({ error: '该标的暂无可用K线详情', attempts }, 502);
  }
}

function rankingQuery(url: URL, snapshotId: string | null): RankQuery {
  return {
    snapshotId,
    market: url.searchParams.get('market') ?? undefined, kind: url.searchParams.get('kind') ?? undefined,
    quadrant: url.searchParams.get('quadrant') ?? undefined, q: url.searchParams.get('q') ?? undefined,
    ids: url.searchParams.get('ids')?.split(',').filter(Boolean) ?? undefined,
    sort: url.searchParams.get('sort') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit: Number(url.searchParams.get('limit')) || 50,
  };
}

function checkAdmin(request: Request, token?: string): boolean {
  if (!token) return false;
  return request.headers.get('x-admin-token') === token;
}

async function safeJson(request: Request): Promise<Record<string, unknown> | null> {
  try { return await request.json() as Record<string, unknown>; } catch { return null; }
}

export function createMarketHandler(router: ProviderRouter) {
  return async function handleMarket(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'chan-dashboard', runtime: 'portable', time: new Date().toISOString() });
    }
    if (url.pathname === '/api/market/providers') {
      return json({ providers: [
        { id: 'eastmoney', name: '东方财富', role: 'primary', note: '前复权日线 · 默认来源' },
        { id: 'tencent', name: '腾讯行情', role: 'fallback', note: 'A股/港股前复权日线 · 自动降级' },
        { id: 'nasdaq', name: 'Nasdaq', role: 'fallback', note: '美股历史日线 · 拆股调整 · 第二备用源' },
      ], strategy: '按标的自动降级，不跨源拼接K线', cache: routerCacheKind(router) });
    }
    if (url.pathname === '/api/market/bars') {
      const id = url.searchParams.get('instrument')?.toUpperCase() ?? '';
      const instrument = INSTRUMENT_MAP.get(id);
      if (!instrument) {
        const body: MarketFailure = { ok: false, instrument: { id, symbol: id, name: '未知标的', market: 'CN', kind: 'stock', currency: 'CNY', providers: {} }, error: { code: 'invalid_instrument', message: '标的不在受支持的配置池中', attempts: [] } };
        return json(body, 400);
      }
      try {
        return json({ ok: true, data: await router.getDaily(instrument, request.signal) });
      } catch (error) {
        if (request.signal.aborted) return json({ error: 'Request cancelled' }, 499);
        const attempts = (error as Error & { attempts?: ProviderAttempt[] }).attempts ?? [];
        const body: MarketFailure = { ok: false, instrument, error: { code: 'all_providers_failed', message: '暂时无法取得有效行情，请稍后重试', attempts } };
        return json(body, 502);
      }
    }
    return json({ error: 'Not found' }, 404);
  };
}

function routerCacheKind(router: ProviderRouter): string {
  return (router as unknown as { options: { cache: { kind: string } } }).options.cache.kind;
}

export function createDefaultRouter(cache: ConstructorParameters<typeof ProviderRouter>[0]['cache'], env: Record<string, string | undefined> = {}): ProviderRouter {
  const numeric = (key: string, fallback: number) => Number(env[key]) > 0 ? Number(env[key]) : fallback;
  return new ProviderRouter({
    providers: [eastmoneyProvider, tencentProvider, nasdaqProvider], cache,
    timeoutMs: numeric('MARKET_REQUEST_TIMEOUT_MS', 9000),
    concurrency: numeric('MARKET_PROVIDER_CONCURRENCY', 4),
    ttlSeconds: numeric('MARKET_CACHE_TTL_SECONDS', 300),
    staleTtlSeconds: numeric('MARKET_STALE_TTL_SECONDS', 86400),
  });
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  } });
}
