import type { AnalysisRecord } from '../../shared/dashboard.ts';
import type {
  CatalogInstrument, CatalogPage, CatalogSnapshot, CatalogSummary, ClaimedScanItem,
  RankEntry, RankedScore, ResearchBrief, CatalogSourceReport,
} from '../../shared/catalog.ts';
import type { Market } from '../../shared/market.ts';
import type { PagedResult } from '../catalog/paged.ts';
import type { DiagnosticRow, CompletedItem, RankQuery, ScanSummary, SyncSourceState, PublishedSnapshotBrief, TrendPoint } from './researchStore.ts';
import { asD1, type D1DatabaseLike, type D1Statement } from './d1Types.ts';

interface InstrumentRow {
  id: string; market: string; kind: string; name: string; symbol: string; exchange: string;
  currency: string; listing_status: string; listed_at: string | null;
  providers_json: string; catalog_source: string; mapping_status: string; version: string;
}

interface RunRow {
  id: string; catalog_version: string; status: string; started_at: string;
  finished_at: string | null; total: number; driver: string; published: number;
  counts_json: string;
}

interface CountRow { status: string; n: number }

/** Published snapshots kept for trend views; older runs and their rows rotate out. */
const SNAPSHOT_RETENTION = 30;

function emptyCounts(): Record<string, number> {
  return { pending: 0, running: 0, succeeded: 0, insufficient_history: 0, no_data: 0, mapping_review: 0, failed_terminal: 0 };
}

function toInstrument(row: InstrumentRow): CatalogInstrument {
  let providers: CatalogInstrument['providers'];
  try { providers = JSON.parse(row.providers_json) as CatalogInstrument['providers']; }
  catch { providers = {}; }
  return {
    id: row.id, market: row.market as Market, kind: row.kind as 'stock' | 'etf', name: row.name,
    symbol: row.symbol, currency: row.currency as 'CNY' | 'HKD' | 'USD', exchange: row.exchange,
    listingStatus: row.listing_status as CatalogInstrument['listingStatus'], listedAt: row.listed_at,
    catalogSource: row.catalog_source as CatalogInstrument['catalogSource'], catalogVersion: row.version,
    mappingStatus: row.mapping_status as CatalogInstrument['mappingStatus'], providers,
  };
}

/**
 * D1-backed store. Catalog sync lands in staging tables one page per request;
 * scan items are chunked; published scores live in the `score` table so
 * rankings page by SQL without loading whole snapshots.
 */
export class D1ResearchStore {
  readonly driver: 'client' | 'server';
  private db: D1DatabaseLike;
  constructor(db: unknown, options: { driver?: 'client' | 'server' } = {}) {
    this.db = asD1(db);
    // 'client' drivers rely on the dashboard-driven pipeline; 'server' drivers auto-drive scans in-process.
    this.driver = options.driver ?? 'client';
  }

  // ---------- Catalog: published ----------

  async publishCatalog(snapshot: CatalogSnapshot): Promise<void> {
    // Used only by local/full sync paths; the paged path publishes through commitCatalog().
    await this.db.batch([this.db.prepare('DELETE FROM instrument'), this.db.prepare('DELETE FROM catalog_meta')]);
    const statements = snapshot.instruments.map((item) => this.insertInstrumentSync(snapshot.version, item));
    for (let i = 0; i < statements.length; i += 200) await this.db.batch(statements.slice(i, i + 200));
    await this.db.prepare('INSERT INTO catalog_meta (version, created_at, complete, sources_json) VALUES (?, ?, ?, ?)')
      .bind(snapshot.version, snapshot.createdAt, snapshot.complete ? 1 : 0, JSON.stringify(snapshot.sources)).run();
  }

  private insertInstrumentSync(version: string, item: CatalogInstrument): D1Statement {
    return this.db.prepare('INSERT OR REPLACE INTO instrument (version, id, market, kind, name, symbol, exchange, currency, listing_status, listed_at, providers_json, catalog_source, mapping_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(version, item.id, item.market, item.kind, item.name, item.symbol, item.exchange, item.currency, item.listingStatus, item.listedAt, JSON.stringify(item.providers), item.catalogSource, item.mappingStatus);
  }

  private async insertStage(source: string, item: CatalogInstrument): Promise<D1Statement> {
    return this.db.prepare('INSERT OR REPLACE INTO stage_row (source, id, market, kind, name, symbol, exchange, currency, listing_status, listed_at, providers_json, catalog_source, mapping_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(source, item.id, item.market, item.kind, item.name, item.symbol, item.exchange, item.currency, item.listingStatus, item.listedAt, JSON.stringify(item.providers), item.catalogSource, item.mappingStatus);
  }

  async currentCatalogVersion(): Promise<string | null> {
    const row = await this.db.prepare('SELECT version FROM catalog_meta ORDER BY created_at DESC LIMIT 1').first<{ version: string }>();
    return row?.version ?? null;
  }

  async findInstrument(id: string): Promise<CatalogInstrument | undefined> {
    const version = await this.currentCatalogVersion();
    if (!version) return undefined;
    const row = await this.db.prepare('SELECT * FROM instrument WHERE version = ? AND id = ?').bind(version, id).first<InstrumentRow>();
    return row ? toInstrument(row) : undefined;
  }

  async catalogSummary(): Promise<CatalogSummary> {
    const meta = await this.db.prepare('SELECT version, created_at, complete, sources_json FROM catalog_meta ORDER BY created_at DESC LIMIT 1').first<{ version: string; created_at: string; complete: number; sources_json: string }>();
    const markets: Record<Market, { total: number; stocks: number; etfs: number; mappingReview: number }> = {
      CN: { total: 0, stocks: 0, etfs: 0, mappingReview: 0 }, HK: { total: 0, stocks: 0, etfs: 0, mappingReview: 0 }, US: { total: 0, stocks: 0, etfs: 0, mappingReview: 0 },
    };
    let total = 0;
    let sources: CatalogSourceReport[] = [];
    if (meta) {
      sources = JSON.parse(meta.sources_json) as CatalogSourceReport[];
      const rows = await this.db.prepare('SELECT market, kind, COUNT(*) AS n FROM instrument WHERE version = ? GROUP BY market, kind').bind(meta.version).all<{ market: Market; kind: string; n: number }>();
      for (const row of rows.results) {
        const group = markets[row.market];
        group.total += row.n;
        if (row.kind === 'etf') group.etfs += row.n; else group.stocks += row.n;
        total += row.n;
      }
      const review = await this.db.prepare("SELECT COUNT(*) AS n FROM instrument WHERE version = ? AND mapping_status = 'mapping_review'").bind(meta.version).first<{ n: number }>();
      for (const key of Object.keys(markets) as Market[]) {
        if (markets[key].total) markets[key].mappingReview = 0;
      }
      // Mapping review is tracked globally; attribute to CN (the only source that uses it today).
      markets.CN.mappingReview = Number(review?.n ?? 0);
    }
    return { version: meta?.version ?? null, createdAt: meta?.created_at ?? null, complete: !!meta && meta.complete === 1, total, markets, sources };
  }

  async listCatalog(query: { market?: string; q?: string; cursor?: string; limit?: number }): Promise<CatalogPage> {
    const version = await this.currentCatalogVersion();
    if (!version) return { instruments: [], nextCursor: null, total: 0 };
    const start = Math.max(0, Number(query.cursor) || 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const filters: string[] = ['version = ?'];
    const params: unknown[] = [version];
    if (query.market) { filters.push('market = ?'); params.push(query.market); }
    if (query.q) { filters.push('(id LIKE ? OR name LIKE ?)'); params.push(`%${query.q}%`, `%${query.q}%`); }
    const where = filters.join(' AND ');
    const totalRow = await this.db.prepare(`SELECT COUNT(*) AS n FROM instrument WHERE ${where}`).bind(...params).first<{ n: number }>();
    const rows = await this.db.prepare(`SELECT * FROM instrument WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`).bind(...params, limit, start).all<InstrumentRow>();
    const total = totalRow?.n ?? 0;
    return { instruments: rows.results.map(toInstrument), nextCursor: start + limit < total ? String(start + limit) : null, total };
  }

  // ---------- Catalog: staged sync (paged) ----------

  async stageCatalogPage(result: PagedResult): Promise<SyncSourceState> {
    if (result.rows.length) {
      const statements = [];
      for (const row of result.rows) statements.push(await this.insertStage(result.source, row));
      // Batch in slices to stay well inside per-request D1 statement limits.
      for (let i = 0; i < statements.length; i += 200) await this.db.batch(statements.slice(i, i + 200));
    }
    const previous = (await this.syncState(result.source))[0];
    const done = result.nextCursor === null;
    const state: SyncSourceState = {
      source: result.source, status: done ? 'complete' : 'running',
      declaredTotal: result.declaredTotal, pageCount: result.pageCount,
      pagesDone: (previous?.pagesDone ?? 0) + 1, stagedCount: (previous?.stagedCount ?? 0) + result.rows.length,
      error: null, updatedAt: new Date().toISOString(),
    };
    await this.upsertSync(state);
    return state;
  }

  /** Mark a catalog source as failed (page fetch or workbook error) so commit stays "未封口". */
  async failCatalogSource(source: string, error: string): Promise<SyncSourceState> {
    const previous = (await this.syncState(source))[0];
    const state: SyncSourceState = {
      source, status: 'failed',
      declaredTotal: previous?.declaredTotal ?? null, pageCount: previous?.pageCount ?? null,
      pagesDone: previous?.pagesDone ?? 0, stagedCount: previous?.stagedCount ?? 0,
      error: error.slice(0, 300), updatedAt: new Date().toISOString(),
    };
    await this.upsertSync(state);
    return state;
  }

  async stageCatalogRows(source: string | 'hkex', rows: CatalogInstrument[], options?: { declaredTotal?: number; pageCount?: number; done?: boolean; sourceDate?: string | null }): Promise<SyncSourceState> {
    if (rows.length) {
      const statements = [];
      for (const row of rows) statements.push(await this.insertStage(source, row));
      for (let i = 0; i < statements.length; i += 200) await this.db.batch(statements.slice(i, i + 200));
    }
    const previous = (await this.syncState(source))[0];
    const stagedCount = await this.db.prepare('SELECT COUNT(*) AS n FROM stage_row WHERE source = ?').bind(source).first<{ n: number }>();
    const state: SyncSourceState = {
      source, status: options?.done ? 'complete' : 'running',
      declaredTotal: options?.declaredTotal ?? previous?.declaredTotal ?? null,
      pageCount: options?.pageCount ?? previous?.pageCount ?? null,
      pagesDone: options?.done ? (options.pageCount ?? 1) : (previous?.pagesDone ?? 0),
      stagedCount: stagedCount?.n ?? 0, error: null, updatedAt: new Date().toISOString(),
    };
    await this.upsertSync(state);
    return state;
  }

  private async upsertSync(state: SyncSourceState): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO sync_log (source, status, declared_total, page_count, pages_done, staged_count, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(state.source, state.status, state.declaredTotal, state.pageCount, state.pagesDone, state.stagedCount, state.error, state.updatedAt).run();
  }

  async syncState(source?: string): Promise<SyncSourceState[]> {
    if (source) {
      const row = await this.db.prepare('SELECT * FROM sync_log WHERE source = ?').bind(source).first<Record<string, unknown>>();
      return row ? [this.toSync(row)] : [];
    }
    const rows = await this.db.prepare('SELECT * FROM sync_log').all<Record<string, unknown>>();
    return rows.results.map((row) => this.toSync(row));
  }

  private toSync(row: Record<string, unknown>): SyncSourceState {
    return { source: row.source as string, status: row.status as SyncSourceState['status'], declaredTotal: (row.declared_total as number | null) ?? null, pageCount: (row.page_count as number | null) ?? null, pagesDone: Number(row.pages_done ?? 0), stagedCount: Number(row.staged_count ?? 0), error: (row.error as string | null) ?? null, updatedAt: String(row.updated_at ?? '') };
  }

  async resetSync(): Promise<void> {
    await this.db.prepare('DELETE FROM stage_row').run();
    await this.db.prepare('DELETE FROM sync_log').run();
  }

  async commitCatalog(): Promise<{ version: string; complete: boolean; total: number; sources: CatalogSourceReport[] }> {
    const syncRows = await this.db.prepare('SELECT * FROM sync_log').all<Record<string, unknown>>();
    const states = syncRows.results.map((row) => this.toSync(row));
    if (!states.length) throw new Error('没有同步中的目录来源');
    const countRow = await this.db.prepare('SELECT COUNT(*) AS n FROM stage_row').first<{ n: number }>();
    const total = countRow?.n ?? 0;
    if (!total) throw new Error('暂存目录为空，无法提交');
    // Partial catalogs are allowed but labelled incomplete — they must never masquerade as full-market.
    // All seven expected sources (6 paged + HKEX workbook) must be present and complete, or the
    // snapshot stays "未封口" even when every staged source finished.
    const expected = ['sse_main', 'sse_star', 'szse_stocks', 'szse_etf', 'nasdaq_stocks', 'nasdaq_etf', 'hkex'];
    const bySource = new Map(states.map((state) => [state.source, state]));
    const complete = expected.every((source) => bySource.get(source)?.status === 'complete');
    const dup = await this.db.prepare('SELECT id, COUNT(DISTINCT source) AS n FROM stage_row GROUP BY id HAVING n > 1 LIMIT 1').first<{ id: string }>();
    if (dup) throw new Error(`跨来源标的ID重复：${dup.id}`);
    const version = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const sources: CatalogSourceReport[] = states.map((state) => ({
      source: state.source as CatalogSourceReport['source'],
      market: state.source.startsWith('sse') || state.source.startsWith('szse') ? 'CN' : state.source === 'hkex' ? 'HK' : 'US',
      scope: state.source, status: state.status === 'complete' ? 'complete' : 'failed', declaredTotal: state.declaredTotal,
      fetchedCount: state.stagedCount, includedCount: state.stagedCount,
      excludedCount: Math.max(0, (state.declaredTotal ?? state.stagedCount) - state.stagedCount),
      pages: state.pagesDone, sourceDate: state.updatedAt, ...(state.error ? { error: state.error } : {}),
    }));
    // Atomic-ish publish: promote staged rows, replace catalog, keep ledger.
    await this.db.batch([
      this.db.prepare('INSERT INTO instrument SELECT ?, id, market, kind, name, symbol, exchange, currency, listing_status, listed_at, providers_json, catalog_source, mapping_status FROM stage_row').bind(version),
      this.db.prepare('DELETE FROM catalog_meta WHERE version != ?').bind(version),
      this.db.prepare('INSERT OR REPLACE INTO catalog_meta (version, created_at, complete, sources_json) VALUES (?, ?, ?, ?)').bind(version, createdAt, complete ? 1 : 0, JSON.stringify(sources)),
      this.db.prepare('DELETE FROM instrument WHERE version != ?').bind(version),
      this.db.prepare('DELETE FROM stage_row'),
      this.db.prepare('DELETE FROM sync_log'),
    ]);
    return { version, complete, total, sources };
  }

  // ---------- Scan lifecycle ----------

  async createScan(catalogVersion: string, instrumentIds?: string[]): Promise<ScanSummary> {
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    let total: number;
    if (instrumentIds?.length) {
      const placeholders = instrumentIds.map(() => '?').join(',');
      const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM instrument WHERE version = ? AND id IN (${placeholders})`).bind(catalogVersion, ...instrumentIds).first<{ n: number }>();
      total = row?.n ?? 0;
      if (!total) throw new Error('当前目录没有可扫描标的');
      await this.db.prepare(`INSERT INTO scan_item (run_id, instrument_id, status) SELECT ?, id, 'pending' FROM instrument WHERE version = ? AND id IN (${placeholders})`).bind(id, catalogVersion, ...instrumentIds).run();
    } else {
      const row = await this.db.prepare('SELECT COUNT(*) AS n FROM instrument WHERE version = ?').bind(catalogVersion).first<{ n: number }>();
      total = row?.n ?? 0;
      if (!total) throw new Error('当前目录没有可扫描标的');
      await this.db.prepare("INSERT INTO scan_item (run_id, instrument_id, status) SELECT ?, id, 'pending' FROM instrument WHERE version = ?").bind(id, catalogVersion).run();
    }
    await this.db.prepare('INSERT INTO scan_run (id, catalog_version, status, started_at, finished_at, total, driver, published) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
      .bind(id, catalogVersion, 'running', startedAt, null, total, this.driver).run();
    const counts = emptyCounts();
    counts.pending = total;
    return { id, catalogVersion, status: 'running', startedAt, finishedAt: null, total, counts, driver: this.driver };
  }

  private async runRow(id: string): Promise<RunRow | null> {
    return this.db.prepare('SELECT * FROM scan_run WHERE id = ?').bind(id).first<RunRow>();
  }

  private async countsOf(runId: string): Promise<Record<string, number>> {
    const rows = await this.db.prepare('SELECT status, COUNT(*) AS n FROM scan_item WHERE run_id = ? GROUP BY status').bind(runId).all<CountRow>();
    const counts = emptyCounts();
    for (const row of rows.results) counts[row.status] = Number(row.n);
    return counts;
  }

  private summary(run: RunRow, counts: Record<string, number>): ScanSummary {
    return { id: run.id, catalogVersion: run.catalog_version, status: run.status as ScanSummary['status'], startedAt: run.started_at, finishedAt: run.finished_at, total: Number(run.total), counts, driver: run.driver as 'client' | 'server' };
  }

  async scanSummary(id: string): Promise<ScanSummary | null> {
    const run = await this.runRow(id);
    if (!run) return null;
    return this.summary(run, await this.countsOf(id));
  }

  async latestScan(): Promise<ScanSummary | null> {
    const run = await this.db.prepare('SELECT * FROM scan_run ORDER BY started_at DESC LIMIT 1').first<RunRow>();
    if (!run) return null;
    return this.summary(run, await this.countsOf(run.id));
  }

  async claimStep(id: string, limit: number, options?: { staleBeforeMs?: number; maxAttempts?: number }): Promise<ClaimedScanItem[]> {
    const run = await this.runRow(id);
    if (!run || run.status !== 'running') return [];
    const maxAttempts = options?.maxAttempts ?? 5;
    const staleBefore = options?.staleBeforeMs != null ? Date.now() - options.staleBeforeMs : null;
    // Crash/reload recovery: items claimed long ago without writeback either
    // get re-claimed (fresh attempts) or become terminal past max attempts so
    // a run can always be closed out.
    if (staleBefore != null) {
      await this.db.prepare(
        "UPDATE scan_item SET status = 'failed_terminal', last_error = ? WHERE run_id = ? AND status = 'running' AND attempts >= ? AND claimed_at IS NOT NULL AND claimed_at <= ?",
      ).bind('领取后未回写（超时回收）', id, maxAttempts, staleBefore).run();
    }
    const limitN = Math.max(1, Math.min(limit, 20));
    const claimed = staleBefore != null
      ? await this.db.prepare(
          "SELECT instrument_id FROM scan_item WHERE run_id = ? AND (status = 'pending' OR (status = 'running' AND attempts < ? AND claimed_at IS NOT NULL AND claimed_at <= ?)) ORDER BY instrument_id LIMIT ?",
        ).bind(id, maxAttempts, staleBefore, limitN).all<{ instrument_id: string }>()
      : await this.db.prepare(
          "SELECT instrument_id FROM scan_item WHERE run_id = ? AND status = 'pending' ORDER BY instrument_id LIMIT ?",
        ).bind(id, limitN).all<{ instrument_id: string }>();
    const ids = claimed.results.map((row) => row.instrument_id);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    await this.db.prepare(`UPDATE scan_item SET status = 'running', attempts = attempts + 1, claimed_at = ? WHERE run_id = ? AND instrument_id IN (${placeholders})`).bind(Date.now(), id, ...ids).run();
    const rows = await this.db.prepare(
      `SELECT i.*, si.instrument_id FROM instrument i JOIN scan_item si ON si.instrument_id = i.id AND i.version = ? WHERE si.run_id = ? AND si.instrument_id IN (${placeholders})`,
    ).bind(run.catalog_version, id, ...ids).all<InstrumentRow & { instrument_id: string }>();
    return rows.results.map((row) => ({
      item: { instrumentId: row.instrument_id, status: 'running' as const, attemptCount: 0, lastError: null },
      instrument: toInstrument(row),
    }));
  }

  async completeStep(id: string, results: CompletedItem[]): Promise<ScanSummary> {
    if (results.length) {
      const statements = results.map((result) => this.db.prepare(
        'UPDATE scan_item SET status = ?, last_error = ?, record_json = ?, chan_score = ?, momentum_raw = ?, stale = ?, claimed_at = NULL WHERE run_id = ? AND instrument_id = ?',
      ).bind(result.status, result.lastError, result.record ? JSON.stringify(result.record) : null, result.record?.chan?.score ?? null, result.record?.momentum?.raw ?? null, result.record?.snapshot?.stale ? 1 : 0, id, result.instrumentId));
      for (let i = 0; i < statements.length; i += 20) await this.db.batch(statements.slice(i, i + 20));
    }
    const run = await this.runRow(id);
    if (!run) throw new Error('扫描任务不存在');
    return this.summary(run, await this.countsOf(id));
  }

  async retryFailed(id: string): Promise<number> {
    const pending = await this.db.prepare("SELECT instrument_id FROM scan_item WHERE run_id = ? AND status = 'failed_terminal'").bind(id).all<{ instrument_id: string }>();
    const ids = pending.results.map((row) => row.instrument_id);
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    await this.db.batch([
      this.db.prepare(`UPDATE scan_item SET status = 'pending', attempts = 0, last_error = NULL, claimed_at = NULL WHERE run_id = ? AND instrument_id IN (${placeholders})`).bind(id, ...ids),
      this.db.prepare("UPDATE scan_run SET status = 'running', finished_at = NULL WHERE id = ?").bind(id),
    ]);
    return ids.length;
  }

  async rawsPage(id: string, cursor: number, limit: number): Promise<{ rows: RankEntry[]; nextCursor: number | null; total: number }> {
    const run = await this.runRow(id);
    if (!run) return { rows: [], nextCursor: null, total: 0 };
    const totalRow = await this.db.prepare("SELECT COUNT(*) AS n FROM scan_item WHERE run_id = ? AND status = 'succeeded'").bind(id).first<{ n: number }>();
    const total = totalRow?.n ?? 0;
    const rows = await this.db.prepare(
      "SELECT si.instrument_id, si.chan_score, si.momentum_raw, i.name, i.market, i.kind FROM scan_item si JOIN instrument i ON i.version = ? AND i.id = si.instrument_id WHERE si.run_id = ? AND si.status = 'succeeded' ORDER BY si.instrument_id LIMIT ? OFFSET ?",
    ).bind(run.catalog_version, id, Math.min(limit, 5000), cursor).all<{ instrument_id: string; chan_score: number; momentum_raw: number; name: string; market: string; kind: string }>();
    const page = rows.results.map((row) => ({ instrumentId: row.instrument_id, name: row.name, market: row.market as 'CN' | 'HK' | 'US', kind: row.kind as 'stock' | 'etf', chanScore: Number(row.chan_score ?? 0), raw: Number(row.momentum_raw ?? 0) }));
    return { rows: page, nextCursor: cursor + page.length < total ? cursor + page.length : null, total };
  }

  async saveScores(id: string, scores: RankedScore[]): Promise<void> {
    if (!scores.length) return;
    const statements = scores.map((score) => this.db.prepare(
      'INSERT OR REPLACE INTO score (run_id, instrument_id, name, market, kind, momentum_score, resonance, quadrant, rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, score.instrumentId, score.name, score.market, score.kind, score.momentumScore, score.resonance, score.quadrant, score.rank));
    for (let i = 0; i < statements.length; i += 100) await this.db.batch(statements.slice(i, i + 100));
  }

  async finalizeScan(id: string): Promise<ResearchBrief> {
    const run = await this.runRow(id);
    if (!run) throw new Error('扫描任务不存在');
    const counts = await this.countsOf(id);
    const scoreCount = (await this.db.prepare('SELECT COUNT(*) AS n FROM score WHERE run_id = ?').bind(id).first<{ n: number }>())?.n ?? 0;
    const terminal = ['succeeded', 'insufficient_history', 'no_data', 'mapping_review', 'failed_terminal'].reduce((sum, key) => sum + (counts[key] ?? 0), 0);
    if (counts.pending > 0 || counts.running > 0 || terminal !== Number(run.total) || !scoreCount) {
      throw new Error(`扫描未封口：目录${run.total}，终态${terminal}，评分${scoreCount}，待处理${counts.pending}`);
    }
    const finishedAt = new Date().toISOString();
    const quadrantRows = await this.db.prepare('SELECT quadrant, COUNT(*) AS n FROM score WHERE run_id = ? GROUP BY quadrant').bind(id).all<{ quadrant: string; n: number }>();
    const staleRow = await this.db.prepare('SELECT SUM(stale) AS n FROM scan_item WHERE run_id = ?').bind(id).first<{ n: number | null }>();
    const quadrants: Record<string, number> = {};
    for (const row of quadrantRows.results) quadrants[row.quadrant] = Number(row.n);
    const countsJson = JSON.stringify(counts);
    // Rotate published snapshots: keep the newest SNAPSHOT_RETENTION so trend
    // views have history; prune superseded runs' scan_item/score children and
    // abandoned unpublished runs, which previously accumulated forever.
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await this.db.batch([
      this.db.prepare("UPDATE scan_run SET status = 'completed', finished_at = ?, published = 1, counts_json = ? WHERE id = ?").bind(finishedAt, countsJson, id),
      this.db.prepare('DELETE FROM scan_run WHERE published = 1 AND id != ? AND id NOT IN (SELECT id FROM scan_run WHERE published = 1 ORDER BY finished_at DESC LIMIT ?)').bind(id, SNAPSHOT_RETENTION),
      this.db.prepare("DELETE FROM scan_item WHERE run_id NOT IN (SELECT id FROM scan_run WHERE published = 1 OR status = 'running')"),
      this.db.prepare("DELETE FROM score WHERE run_id NOT IN (SELECT id FROM scan_run WHERE published = 1 OR status = 'running')"),
      this.db.prepare("DELETE FROM scan_run WHERE published = 0 AND status != 'running' AND started_at <= ?").bind(cutoff),
    ]);
    return {
      id, catalogVersion: run.catalog_version, createdAt: finishedAt, algorithmVersion: 'legacy-v1',
      complete: true, total: Number(run.total), ready: scoreCount, stale: Number(staleRow?.n ?? 0),
      failed: (counts.insufficient_history ?? 0) + (counts.no_data ?? 0) + (counts.mapping_review ?? 0) + (counts.failed_terminal ?? 0),
      quadrants,
    };
  }

  // ---------- Published snapshot reads ----------

  async researchBrief(): Promise<ResearchBrief | null> {
    const run = await this.db.prepare('SELECT * FROM scan_run WHERE published = 1 ORDER BY finished_at DESC LIMIT 1').first<RunRow>();
    if (!run || !run.finished_at) return null;
    const counts = JSON.parse(run.counts_json || '{}') as Record<string, number>;
    const scoreCount = (await this.db.prepare('SELECT COUNT(*) AS n FROM score WHERE run_id = ?').bind(run.id).first<{ n: number }>())?.n ?? 0;
    if (!scoreCount) return null;
    const quadrantRows = await this.db.prepare('SELECT quadrant, COUNT(*) AS n FROM score WHERE run_id = ? GROUP BY quadrant').bind(run.id).all<{ quadrant: string; n: number }>();
    const staleRow = await this.db.prepare('SELECT SUM(stale) AS n FROM scan_item WHERE run_id = ?').bind(run.id).first<{ n: number | null }>();
    const quadrants: Record<string, number> = {};
    for (const row of quadrantRows.results) quadrants[row.quadrant] = Number(row.n);
    return {
      id: run.id, catalogVersion: run.catalog_version, createdAt: run.finished_at, algorithmVersion: 'legacy-v1',
      complete: true, total: Number(run.total), ready: scoreCount, stale: Number(staleRow?.n ?? 0),
      failed: (counts.insufficient_history ?? 0) + (counts.no_data ?? 0) + (counts.mapping_review ?? 0) + (counts.failed_terminal ?? 0),
      quadrants,
    };
  }

  private async publishedRunId(snapshotId?: string | null): Promise<string | null> {
    if (snapshotId) {
      const run = await this.db.prepare('SELECT id FROM scan_run WHERE published = 1 AND id = ?').bind(snapshotId).first<{ id: string }>();
      return run?.id ?? null;
    }
    const run = await this.db.prepare('SELECT id FROM scan_run WHERE published = 1 ORDER BY finished_at DESC LIMIT 1').first<{ id: string }>();
    return run?.id ?? null;
  }

  async rankingsPage(query: RankQuery): Promise<{ items: AnalysisRecord[]; total: number; nextCursor: string | null }> {
    const runId = await this.publishedRunId(query.snapshotId);
    if (!runId) return { items: [], total: 0, nextCursor: null };
    const start = Math.max(0, Number(query.cursor) || 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const filters: string[] = ['s.run_id = ?'];
    const params: unknown[] = [runId];
    if (query.market) { filters.push('s.market = ?'); params.push(query.market); }
    if (query.kind) { filters.push('s.kind = ?'); params.push(query.kind); }
    if (query.quadrant) { filters.push('s.quadrant = ?'); params.push(query.quadrant); }
    if (query.q) { filters.push('(s.name LIKE ? OR s.instrument_id LIKE ?)'); params.push(`%${query.q}%`, `%${query.q}%`); }
    if (query.ids?.length) { filters.push(`s.instrument_id IN (${query.ids.map(() => '?').join(',')})`); params.push(...query.ids); }
    const where = filters.join(' AND ');
    const totalRow = await this.db.prepare(`SELECT COUNT(*) AS n FROM score s WHERE ${where}`).bind(...params).first<{ n: number }>();
    const rows = await this.db.prepare(
      `SELECT s.instrument_id, s.momentum_score, s.resonance, s.quadrant, s.rank, i.record_json FROM score s JOIN scan_item i ON i.run_id = s.run_id AND i.instrument_id = s.instrument_id WHERE ${where} ORDER BY s.rank LIMIT ? OFFSET ?`,
    ).bind(...params, limit, start).all<{ instrument_id: string; momentum_score: number; resonance: number; quadrant: string; rank: number; record_json: string }>();
    const items: AnalysisRecord[] = [];
    for (const row of rows.results) {
      let record: AnalysisRecord;
      try { record = JSON.parse(row.record_json) as AnalysisRecord; } catch { continue; }
      items.push({ ...record, momentumScore: Number(row.momentum_score), resonance: Number(row.resonance), quadrant: row.quadrant as AnalysisRecord['quadrant'], rank: Number(row.rank), rankDelta: record.rankDelta ?? null });
    }
    const total = totalRow?.n ?? 0;
    return { items, total, nextCursor: start + items.length < total ? String(start + items.length) : null };
  }

  async diagnosticsPage(query: RankQuery): Promise<{ items: DiagnosticRow[]; total: number; nextCursor: string | null }> {
    const runId = await this.publishedRunId(query.snapshotId);
    if (!runId) return { items: [], total: 0, nextCursor: null };
    const start = Math.max(0, Number(query.cursor) || 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const filters = ["si.run_id = ? AND si.status NOT IN ('pending', 'running', 'succeeded')"];
    const params: unknown[] = [runId];
    if (query.status) { filters.push('si.status = ?'); params.push(query.status); }
    if (query.q) { filters.push('(si.instrument_id LIKE ? OR i.name LIKE ?)'); params.push(`%${query.q}%`, `%${query.q}%`); }
    const where = filters.join(' AND ');
    const totalRow = await this.db.prepare(`SELECT COUNT(*) AS n FROM scan_item si LEFT JOIN instrument i ON i.id = si.instrument_id WHERE ${where}`).bind(...params).first<{ n: number }>();
    const rows = await this.db.prepare(
      `SELECT si.instrument_id, si.status, si.attempts, si.last_error, i.name FROM scan_item si LEFT JOIN instrument i ON i.id = si.instrument_id WHERE ${where} ORDER BY si.instrument_id LIMIT ? OFFSET ?`,
    ).bind(...params, limit, start).all<{ instrument_id: string; status: string; attempts: number; last_error: string | null; name: string | null }>();
    return { items: rows.results.map((row) => ({ instrumentId: row.instrument_id, name: row.name ?? row.instrument_id, status: row.status, attemptCount: Number(row.attempts), lastError: row.last_error })), total: totalRow?.n ?? 0, nextCursor: start + rows.results.length < (totalRow?.n ?? 0) ? String(start + rows.results.length) : null };
  }

  async snapshotHistory(limit = 30): Promise<PublishedSnapshotBrief[]> {
    const capped = Math.min(90, Math.max(1, limit));
    const runs = await this.db.prepare('SELECT id, finished_at, total, counts_json FROM scan_run WHERE published = 1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?').bind(capped).all<{ id: string; finished_at: string; total: number; counts_json: string }>();
    if (!runs.results.length) return [];
    const ids = runs.results.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    const readyRows = await this.db.prepare(`SELECT run_id, COUNT(*) AS n FROM score WHERE run_id IN (${placeholders}) GROUP BY run_id`).bind(...ids).all<{ run_id: string; n: number }>();
    const quadRows = await this.db.prepare(`SELECT run_id, quadrant, COUNT(*) AS n FROM score WHERE run_id IN (${placeholders}) GROUP BY run_id, quadrant`).bind(...ids).all<{ run_id: string; quadrant: string; n: number }>();
    const ready = new Map(readyRows.results.map((row) => [row.run_id, Number(row.n)]));
    const quadrants = new Map<string, Record<string, number>>();
    for (const row of quadRows.results) {
      const perRun = quadrants.get(row.run_id) ?? {};
      perRun[row.quadrant] = Number(row.n);
      quadrants.set(row.run_id, perRun);
    }
    return runs.results.map((row) => {
      const counts = JSON.parse(row.counts_json || '{}') as Record<string, number>;
      const failed = ['insufficient_history', 'no_data', 'mapping_review', 'failed_terminal'].reduce((sum, key) => sum + (counts[key] ?? 0), 0);
      return { id: row.id, createdAt: row.finished_at, ready: ready.get(row.id) ?? 0, failed, total: Number(row.total), quadrants: quadrants.get(row.id) ?? {} };
    });
  }

  async trendPoints(query: { ids: string[]; limit?: number }): Promise<TrendPoint[]> {
    if (!query.ids.length) return [];
    const capped = Math.min(90, Math.max(1, query.limit ?? 30));
    const ids = query.ids.slice(0, 300);
    const runs = await this.db.prepare('SELECT id, finished_at FROM scan_run WHERE published = 1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?').bind(capped).all<{ id: string; finished_at: string }>();
    if (!runs.results.length) return [];
    runs.results.reverse();
    const runPlaceholders = runs.results.map(() => '?').join(',');
    const idPlaceholders = ids.map(() => '?').join(',');
    const rows = await this.db.prepare(
      `SELECT s.run_id, s.instrument_id, s.rank, s.quadrant, s.momentum_score, si.chan_score FROM score s JOIN scan_item si ON si.run_id = s.run_id AND si.instrument_id = s.instrument_id WHERE s.run_id IN (${runPlaceholders}) AND s.instrument_id IN (${idPlaceholders}) ORDER BY s.instrument_id, s.run_id`,
    ).bind(...runs.results.map((row) => row.id), ...ids).all<{ run_id: string; instrument_id: string; rank: number; quadrant: string; momentum_score: number; chan_score: number | null }>();
    const createdAt = new Map(runs.results.map((row) => [row.id, row.finished_at]));
    return rows.results.map((row) => ({
      snapshotId: row.run_id, createdAt: createdAt.get(row.run_id) ?? null, instrumentId: row.instrument_id,
      rank: row.rank == null ? null : Number(row.rank), quadrant: row.quadrant ?? null,
      chanScore: row.chan_score == null ? null : Number(row.chan_score), momentumScore: row.momentum_score == null ? null : Number(row.momentum_score),
    }));
  }

  async getAppState(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT value FROM app_state WHERE key = ?').bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setAppState(key: string, value: string): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)').bind(key, value, new Date().toISOString()).run();
  }
}
