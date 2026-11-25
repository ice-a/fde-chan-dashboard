import type { AnalysisRecord } from '../../shared/dashboard.ts';
import type {
  CatalogInstrument, CatalogPage, CatalogSnapshot, CatalogSummary, ClaimedScanItem,
  RankEntry, RankedScore, ResearchBrief, CatalogSourceReport,
} from '../../shared/catalog.ts';
import type { PagedResult } from '../catalog/paged.ts';

/** Lightweight scan header: counts are always live, items are never shipped. */
export interface ScanSummary {
  id: string;
  catalogVersion: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  total: number;
  counts: Record<string, number>;
  driver: 'client' | 'server';
}

export interface CompletedItem {
  instrumentId: string;
  status: 'succeeded' | 'insufficient_history' | 'no_data' | 'mapping_review' | 'failed_terminal';
  lastError: string | null;
  record: AnalysisRecord | null;
}

export interface RankQuery {
  snapshotId?: string | null;
  market?: string;
  kind?: string;
  quadrant?: string;
  q?: string;
  ids?: string[];
  sort?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

export interface DiagnosticRow {
  instrumentId: string;
  name: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
}

export interface SyncSourceState {
  source: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  declaredTotal: number | null;
  pageCount: number | null;
  pagesDone: number;
  stagedCount: number;
  error: string | null;
  updatedAt: string;
}

/**
 * Persistent research store. Catalog sync is paged (one source page per
 * request) and scans are chunked ("step") so long full-market runs survive
 * Request lifetimes and can be resumed after a reload.
 */
export interface ResearchStore {
  /** 'client' stores require the dashboard to drive scan/sync steps; 'server' stores auto-drive in-process (Node). */
  readonly driver: 'client' | 'server';

  // Catalog: published view
  publishCatalog(snapshot: CatalogSnapshot): Promise<void>;
  catalogSummary(): Promise<CatalogSummary>;
  currentCatalogVersion(): Promise<string | null>;
  findInstrument(id: string): Promise<CatalogInstrument | undefined>;
  listCatalog(query: { market?: string; q?: string; cursor?: string; limit?: number }): Promise<CatalogPage>;

  // Catalog: staged sync (paged) — required for driver='client'
  stageCatalogPage(result: PagedResult): Promise<SyncSourceState>;
  stageCatalogRows(source: string | 'hkex', rows: CatalogInstrument[], options?: { declaredTotal?: number; pageCount?: number; done?: boolean; sourceDate?: string | null }): Promise<SyncSourceState>;
  failCatalogSource(source: string, error: string): Promise<SyncSourceState>;
  syncState(): Promise<SyncSourceState[]>;
  resetSync(): Promise<void>;
  commitCatalog(): Promise<{ version: string; complete: boolean; total: number; sources: CatalogSourceReport[] }>;

  // Scan lifecycle (chunked)
  createScan(catalogVersion: string, instrumentIds?: string[]): Promise<ScanSummary>;
  scanSummary(id: string): Promise<ScanSummary | null>;
  latestScan(): Promise<ScanSummary | null>;
  /**
   * Claim the next pending items for processing. With options, also re-claims
   * items stuck in 'running' past staleBeforeMs (crash/reload recovery), and
   * fails items that have been claimed more than maxAttempts times without
   * completion so a run can always be closed out.
   */
  claimStep(id: string, limit: number, options?: { staleBeforeMs?: number; maxAttempts?: number }): Promise<ClaimedScanItem[]>;
  completeStep(id: string, results: CompletedItem[]): Promise<ScanSummary>;
  retryFailed(id: string): Promise<number>;
  rawsPage(id: string, cursor: number, limit: number): Promise<{ rows: RankEntry[]; nextCursor: number | null; total: number }>;
  saveScores(id: string, scores: RankedScore[]): Promise<void>;
  finalizeScan(id: string): Promise<ResearchBrief>;

  // Published snapshot reads (paged)
  researchBrief(): Promise<ResearchBrief | null>;
  rankingsPage(query: RankQuery): Promise<{ items: AnalysisRecord[]; total: number; nextCursor: string | null }>;
  diagnosticsPage(query: RankQuery): Promise<{ items: DiagnosticRow[]; total: number; nextCursor: string | null }>;

  /** Published snapshots newest-first (bounded list for trend views). */
  snapshotHistory(limit?: number): Promise<PublishedSnapshotBrief[]>;
  /** Cross-snapshot points for the given instruments, oldest first. */
  trendPoints(query: { ids: string[]; limit?: number }): Promise<TrendPoint[]>;

  /** Small key/value memory for cron scheduling state (dates, retry markers). */
  getAppState(key: string): Promise<string | null>;
  setAppState(key: string, value: string): Promise<void>;
}

/** Bounded snapshot header for history/trend views. */
export interface PublishedSnapshotBrief {
  id: string;
  createdAt: string | null;
  ready: number;
  failed: number;
  total: number;
  quadrants: Record<string, number>;
}

export interface TrendPoint {
  snapshotId: string;
  createdAt: string | null;
  instrumentId: string;
  rank: number | null;
  quadrant: string | null;
  chanScore: number | null;
  momentumScore: number | null;
}

function emptyCounts(): Record<string, number> {
  return { pending: 0, running: 0, succeeded: 0, insufficient_history: 0, no_data: 0, mapping_review: 0, failed_terminal: 0 };
}

interface MemoryItem {
  instrumentId: string;
  status: 'pending' | 'running' | 'succeeded' | 'insufficient_history' | 'no_data' | 'mapping_review' | 'failed_terminal';
  attempts: number;
  lastError: string | null;
  claimedAt?: number;
}
interface MemoryRun {
  id: string;
  catalogVersion: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  total: number;
  items: Map<string, MemoryItem>;
  records: Map<string, AnalysisRecord>;
  scores: Map<string, RankedScore>;
  brief: ResearchBrief | null;
}

/** Published runs kept for trend views (matches D1 retention). */
const SNAPSHOT_RETENTION = 30;

/**
 * In-process store for Node/Docker development. Same chunked contracts as the
 * D1 store; data resets with the process (documented in README).
 */
export class MemoryResearchStore implements ResearchStore {
  readonly driver = 'server' as const;
  private catalog: CatalogSnapshot | null = null;
  private runs = new Map<string, MemoryRun>();
  private sync = new Map<string, SyncSourceState>();
  private staged = new Map<string, CatalogInstrument[]>();
  private appState = new Map<string, string>();

  async publishCatalog(snapshot: CatalogSnapshot): Promise<void> {
    this.catalog = snapshot;
    this.staged.clear();
    this.sync.clear();
  }

  async catalogSummary(): Promise<CatalogSummary> {
    const { summarizeCatalog } = await import('../../shared/catalog.ts');
    return summarizeCatalog(this.catalog);
  }

  async currentCatalogVersion(): Promise<string | null> { return this.catalog?.version ?? null; }

  async findInstrument(id: string): Promise<CatalogInstrument | undefined> {
    return this.catalog?.instruments.find((item) => item.id === id);
  }

  async listCatalog(query: { market?: string; q?: string; cursor?: string; limit?: number }): Promise<CatalogPage> {
    const all = (this.catalog?.instruments ?? []).filter((item) =>
      (!query.market || item.market === query.market) &&
      (!query.q || `${item.id} ${item.name}`.toLowerCase().includes(query.q.toLowerCase())));
    const start = Math.max(0, Number(query.cursor) || 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    return { instruments: all.slice(start, start + limit), nextCursor: start + limit < all.length ? String(start + limit) : null, total: all.length };
  }

  /** Stages one fetched page; cursor continuity comes from sync_log pagesDone. */
  async stageCatalogPage(result: PagedResult): Promise<SyncSourceState> {
    const state = await this.stageCatalogRows(result.source, result.rows, { declaredTotal: result.declaredTotal ?? undefined, pageCount: result.pageCount ?? undefined, done: result.nextCursor === null });
    state.pagesDone += 1;
    return state;
  }

  async stageCatalogRows(source: string | 'hkex', rows: CatalogInstrument[], options?: { declaredTotal?: number; pageCount?: number; done?: boolean; sourceDate?: string | null }): Promise<SyncSourceState> {
    const existing = this.staged.get(source) ?? [];
    const map = new Map(existing.map((row) => [row.id, row]));
    for (const row of rows) map.set(row.id, { ...row, catalogSource: source === 'hkex' ? 'hkex' : row.catalogSource });
    const merged = [...map.values()];
    this.staged.set(source, merged);
    const state: SyncSourceState = this.sync.get(source) ?? { source, status: 'pending', declaredTotal: null, pageCount: options?.pageCount ?? null, pagesDone: 0, stagedCount: 0, error: null, updatedAt: new Date().toISOString() };
    state.stagedCount = merged.length;
    state.declaredTotal = options?.declaredTotal ?? state.declaredTotal;
    state.status = options?.done ? 'complete' : 'running';
    state.pagesDone = options?.done ? (options.pageCount ?? state.pagesDone + 1) : state.pagesDone;
    state.updatedAt = new Date().toISOString();
    this.sync.set(source, state);
    return state;
  }

  async failCatalogSource(source: string, error: string): Promise<SyncSourceState> {
    const previous = this.sync.get(source);
    const state: SyncSourceState = { source, status: 'failed', declaredTotal: previous?.declaredTotal ?? null, pageCount: previous?.pageCount ?? null, pagesDone: previous?.pagesDone ?? 0, stagedCount: previous?.stagedCount ?? 0, error: error.slice(0, 300), updatedAt: new Date().toISOString() };
    this.sync.set(source, state);
    return state;
  }

  async syncState(): Promise<SyncSourceState[]> { return [...this.sync.values()]; }
  async resetSync(): Promise<void> { this.sync.clear(); this.staged.clear(); }

  async commitCatalog(): Promise<{ version: string; complete: boolean; total: number; sources: CatalogSourceReport[] }> {
    const all = new Map<string, CatalogInstrument>();
    for (const rows of this.staged.values()) for (const row of rows) {
      if (all.has(row.id)) throw new Error(`跨来源标的ID重复：${row.id}`);
      all.set(row.id, row);
    }
    if (!all.size) throw new Error('暂存目录为空，无法提交');
    const states = [...this.sync.values()];
    const complete = states.length > 0 && states.every((state) => state.status === 'complete');
    const sources: CatalogSourceReport[] = states.map((state) => ({
      source: state.source === 'hkex' ? 'hkex' : state.source as CatalogSourceReport['source'],
      market: state.source.startsWith('sse') || state.source.startsWith('szse') ? 'CN' : state.source === 'hkex' ? 'HK' : 'US',
      scope: state.source, status: state.status === 'complete' ? 'complete' : 'failed',
      declaredTotal: state.declaredTotal, fetchedCount: state.stagedCount, includedCount: state.stagedCount,
      excludedCount: Math.max(0, (state.declaredTotal ?? state.stagedCount) - state.stagedCount),
      pages: state.pagesDone, sourceDate: state.updatedAt, ...(state.error ? { error: state.error } : {}),
    }));
    const snapshot: CatalogSnapshot = { version: crypto.randomUUID(), createdAt: new Date().toISOString(), complete, instruments: [...all.values()], sources };
    await this.publishCatalog(snapshot);
    return { version: snapshot.version, complete, total: snapshot.instruments.length, sources };
  }

  async createScan(catalogVersion: string, instrumentIds?: string[]): Promise<ScanSummary> {
    const selected = (this.catalog?.instruments ?? []).filter((item) => !instrumentIds || instrumentIds.includes(item.id));
    if (!selected.length) throw new Error('当前目录没有可扫描标的');
    const run: MemoryRun = {
      id: crypto.randomUUID(), catalogVersion, status: 'running',
      startedAt: new Date().toISOString(), finishedAt: null, total: selected.length,
      items: new Map(selected.map((item) => [item.id, { instrumentId: item.id, status: 'pending', attempts: 0, lastError: null }])),
      records: new Map(), scores: new Map(), brief: null,
    };
    this.runs.set(run.id, run);
    return this.summary(run);
  }

  async scanSummary(id: string): Promise<ScanSummary | null> {
    const run = this.runs.get(id);
    return run ? this.summary(run) : null;
  }

  async latestScan(): Promise<ScanSummary | null> {
    const run = [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return run ? this.summary(run) : null;
  }

  async claimStep(id: string, limit: number, options?: { staleBeforeMs?: number; maxAttempts?: number }): Promise<ClaimedScanItem[]> {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running') return [];
    const maxAttempts = options?.maxAttempts ?? 5;
    const staleBefore = options?.staleBeforeMs != null ? Date.now() - options.staleBeforeMs : Number.MAX_SAFE_INTEGER;
    // Items claimed but never written back past max attempts become terminal
    // failures so a run can always be closed out.
    for (const item of run.items.values()) {
      if (item.status === 'running' && item.attempts >= maxAttempts && (item.claimedAt ?? 0) <= staleBefore) {
        item.status = 'failed_terminal';
        item.lastError = '领取后未回写（超时回收）';
      }
    }
    const claimed: ClaimedScanItem[] = [];
    for (const item of run.items.values()) {
      if (claimed.length >= limit) break;
      const reclaimable = item.status === 'running' && item.attempts < maxAttempts && (item.claimedAt ?? 0) <= staleBefore;
      if (item.status !== 'pending' && !reclaimable) continue;
      item.status = 'running';
      item.attempts++;
      item.claimedAt = Date.now();
      const instrument = await this.findInstrument(item.instrumentId);
      if (!instrument) { item.status = 'failed_terminal'; item.lastError = '目录缺少该标的'; continue; }
      claimed.push({ item: { instrumentId: item.instrumentId, status: 'running', attemptCount: item.attempts, lastError: null }, instrument });
    }
    return claimed;
  }

  async completeStep(id: string, results: CompletedItem[]): Promise<ScanSummary> {
    const run = this.runs.get(id);
    if (!run) throw new Error('扫描任务不存在');
    for (const result of results) {
      const item = run.items.get(result.instrumentId);
      if (item) { item.status = result.status; item.lastError = result.lastError; item.claimedAt = undefined; }
      if (result.record) run.records.set(result.instrumentId, result.record);
    }
    return this.summary(run);
  }

  async retryFailed(id: string): Promise<number> {
    const run = this.runs.get(id);
    if (!run) return 0;
    let count = 0;
    for (const item of run.items.values()) {
      if (item.status === 'failed_terminal') { item.status = 'pending'; item.attempts = 0; item.lastError = null; count++; }
    }
    if (count) { run.status = 'running'; run.finishedAt = null; run.brief = null; }
    return count;
  }

  async rawsPage(id: string, cursor: number, limit: number): Promise<{ rows: RankEntry[]; nextCursor: number | null; total: number }> {
    const run = this.runs.get(id);
    if (!run) return { rows: [], nextCursor: null, total: 0 };
    const entries: RankEntry[] = [];
    for (const [instrumentId, record] of run.records) {
      if (!record.chan || !record.momentum) continue;
      entries.push({ instrumentId, name: record.instrument.name, market: record.instrument.market, kind: record.instrument.kind, chanScore: record.chan.score, raw: record.momentum.raw });
    }
    entries.sort((a, b) => a.instrumentId.localeCompare(b.instrumentId));
    const rows = entries.slice(cursor, cursor + limit);
    return { rows, nextCursor: cursor + limit < entries.length ? cursor + limit : null, total: entries.length };
  }

  async saveScores(id: string, scores: RankedScore[]): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new Error('扫描任务不存在');
    for (const score of scores) run.scores.set(score.instrumentId, score);
  }

  async finalizeScan(id: string): Promise<ResearchBrief> {
    const run = this.runs.get(id);
    if (!run) throw new Error('扫描任务不存在');
    const counts = this.counts(run);
    const terminal = ['succeeded', 'insufficient_history', 'no_data', 'mapping_review', 'failed_terminal']
      .reduce((sum, key) => sum + (counts[key] ?? 0), 0);
    if (counts.pending > 0 || counts.running > 0 || terminal !== run.total || !run.scores.size) {
      throw new Error(`扫描未封口：目录${run.total}，终态${terminal}，评分${run.scores.size}，待处理${counts.pending}`);
    }
    let stale = 0;
    for (const record of run.records.values()) if (record.snapshot?.stale) stale++;
    const quadrants: Record<string, number> = {};
    for (const score of run.scores.values()) quadrants[score.quadrant] = (quadrants[score.quadrant] ?? 0) + 1;
    run.status = 'completed';
    run.finishedAt = new Date().toISOString();
    const brief: ResearchBrief = {
      id: run.id, catalogVersion: run.catalogVersion, createdAt: run.finishedAt,
      algorithmVersion: 'legacy-v1', complete: true, total: run.total,
      ready: run.scores.size, stale, failed: counts.insufficient_history + counts.no_data + counts.mapping_review + counts.failed_terminal,
      quadrants,
    };
    run.brief = brief;
    // Rotate: keep the newest SNAPSHOT_RETENTION completed runs (plus any still
    // running) so trend views have history without unbounded growth.
    const completed = [...this.runs.values()]
      .filter((item) => item.status === 'completed' && item.id !== run.id)
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    for (const stale of completed.slice(Math.max(0, SNAPSHOT_RETENTION - 1))) this.runs.delete(stale.id);
    for (const abandoned of [...this.runs.values()]) {
      if (abandoned.status === 'running' && abandoned.startedAt <= new Date(Date.now() - 7 * 86_400_000).toISOString()) this.runs.delete(abandoned.id);
    }
    return brief;
  }

  async researchBrief(): Promise<ResearchBrief | null> {
    const completed = [...this.runs.values()].filter((run) => run.status === 'completed' && run.brief)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return completed[0]?.brief ?? null;
  }

  async snapshotHistory(limit = 30): Promise<PublishedSnapshotBrief[]> {
    return [...this.runs.values()].filter((run) => run.status === 'completed' && run.brief)
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
      .slice(0, limit)
      .map((run) => ({ id: run.id, createdAt: run.finishedAt, ready: run.brief!.ready, failed: run.brief!.failed, total: run.total, quadrants: run.brief!.quadrants }));
  }

  async trendPoints(query: { ids: string[]; limit?: number }): Promise<TrendPoint[]> {
    const ids = new Set(query.ids);
    if (!ids.size) return [];
    const runs = [...this.runs.values()].filter((run) => run.status === 'completed' && run.brief)
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
      .slice(0, Math.min(Math.max(1, query.limit ?? 30), 90))
      .reverse();
    const points: TrendPoint[] = [];
    for (const run of runs) {
      for (const [instrumentId, score] of run.scores) {
        if (!ids.has(instrumentId)) continue;
        const record = run.records.get(instrumentId);
        points.push({ snapshotId: run.id, createdAt: run.finishedAt, instrumentId, rank: score.rank, quadrant: score.quadrant, chanScore: record?.chan?.score ?? null, momentumScore: score.momentumScore });
      }
    }
    return points;
  }

  async getAppState(key: string): Promise<string | null> { return this.appState.get(key) ?? null; }
  async setAppState(key: string, value: string): Promise<void> { this.appState.set(key, value); }

  async rankingsPage(query: RankQuery): Promise<{ items: AnalysisRecord[]; total: number; nextCursor: string | null }> {
    const run = [...this.runs.values()].filter((item) => item.status === 'completed')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .find((item) => !query.snapshotId || item.id === query.snapshotId);
    if (!run) return { items: [], total: 0, nextCursor: null };
    const start = Math.max(0, Number(query.cursor) || 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const scores = [...run.scores.values()].sort((a, b) => a.rank - b.rank).filter((score) => {
      if (query.market && score.market !== query.market) return false;
      if (query.kind && score.kind !== query.kind) return false;
      if (query.quadrant && score.quadrant !== query.quadrant) return false;
      if (query.ids?.length && !query.ids.includes(score.instrumentId)) return false;
      if (query.q && !`${score.instrumentId} ${score.name}`.toLowerCase().includes(query.q.toLowerCase())) return false;
      return run.records.has(score.instrumentId);
    });
    const page = scores.slice(start, start + limit);
    const items = page.map((score) => {
      const record = run.records.get(score.instrumentId)!;
      return { ...record, chanScore: record.chan?.score ?? null, momentumScore: score.momentumScore, resonance: score.resonance, quadrant: score.quadrant as AnalysisRecord['quadrant'], rank: score.rank, rankDelta: null };
    });
    return { items, total: scores.length, nextCursor: start + limit < scores.length ? String(start + limit) : null };
  }

  async diagnosticsPage(query: RankQuery): Promise<{ items: DiagnosticRow[]; total: number; nextCursor: string | null }> {
    const run = [...this.runs.values()].filter((item) => item.status === 'completed')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!run) return { items: [], total: 0, nextCursor: null };
    const start = Math.max(0, Number(query.cursor) || 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const rows: DiagnosticRow[] = [];
    for (const item of run.items.values()) {
      if (run.records.has(item.instrumentId)) continue;
      rows.push({ instrumentId: item.instrumentId, name: item.instrumentId, status: item.status, attemptCount: item.attempts, lastError: item.lastError });
    }
    rows.sort((a, b) => a.instrumentId.localeCompare(b.instrumentId));
    return { items: rows.slice(start, start + limit), total: rows.length, nextCursor: start + limit < rows.length ? String(start + limit) : null };
  }

  private counts(run: MemoryRun): Record<string, number> {
    const counts = emptyCounts();
    for (const item of run.items.values()) {
      if (item.status === 'pending') counts.pending++;
      else if (item.status === 'running') counts.running++;
      else counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    return counts;
  }

  private summary(run: MemoryRun): ScanSummary {
    return { id: run.id, catalogVersion: run.catalogVersion, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, total: run.total, counts: this.counts(run), driver: this.driver };
  }
}

export function createDefaultResearchStore(): ResearchStore {
  return new MemoryResearchStore();
}
