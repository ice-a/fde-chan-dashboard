<template>
  <section aria-labelledby="market-title">
    <div class="section-heading"><div><span class="section-index">00</span><h2 id="market-title">全市场目录与扫描</h2></div><span>目录完整、每只有终态、失败可重试</span></div>
    <div class="panel market-panel">
      <div class="market-toolbar">
        <div class="market-stats" v-if="overview.summary">
          <div class="market-stat"><span>目录版本</span><strong :class="overview.summary.complete ? 'ok' : 'warn'">{{ overview.summary.complete ? '完整' : '未封口' }}<small>{{ overview.summary.version?.slice(0, 8) ?? '未同步' }}</small></strong></div>
          <div class="market-stat"><span>标的总数</span><strong>{{ overview.summary.total.toLocaleString() }}<small>{{ overview.summary.createdAt ? new Date(overview.summary.createdAt).toLocaleString('zh-CN', { hour12: false }) : '尚未同步' }}</small></strong></div>
          <div class="market-stat" v-for="(market, key) in overview.summary.markets" :key="key"><span>{{ marketLabels[key as 'CN' | 'HK' | 'US'] }}</span><strong>{{ market.total.toLocaleString() }}<small v-if="market.etfs > 0">{{ market.stocks.toLocaleString() }} 股 · {{ market.etfs.toLocaleString() }} ETF</small><small v-else-if="market.total">全部为普通股</small><small v-else>未同步</small></strong></div>
        </div>
        <div class="market-actions">
          <button class="button subtle" :disabled="busy" @click="syncCatalog">{{ syncLabel }}</button>
          <button class="button primary" :disabled="busy || !overview.summary?.total" @click="startScan">{{ scanLabel }}</button>
        </div>
      </div>

      <div v-if="syncStates.length" class="market-sources">
        <div v-for="state in syncStates" :key="state.source" class="source-chip" :class="{ failed: state.status === 'failed' }">
          <strong>{{ sourceLabel(state.source) }}</strong>
          <span v-if="state.status === 'complete'">{{ state.stagedCount.toLocaleString() }} 只<span v-if="state.declaredTotal && state.declaredTotal !== state.stagedCount"> / 声明 {{ state.declaredTotal.toLocaleString() }}</span></span>
          <span v-else-if="state.status === 'running'">第 {{ state.pagesDone }}{{ state.pageCount ? ` / ${state.pageCount}` : '' }} 页 · {{ state.stagedCount.toLocaleString() }} 只</span>
          <span v-else>{{ state.error ?? '未同步' }}</span>
        </div>
      </div>
      <div v-else-if="overview.summary?.sources?.length" class="market-sources">
        <div v-for="source in overview.summary.sources" :key="source.source + source.scope" class="source-chip" :class="{ failed: source.status !== 'complete' }">
          <strong>{{ sourceLabel(source.source) }}</strong><span>{{ source.scope }}</span><small>{{ source.status === 'complete' ? `${source.includedCount.toLocaleString()} 只` : source.error }}</small>
        </div>
      </div>

      <div v-if="scan" class="scan-progress">
        <div class="scan-bar"><i :style="{ width: progressPercent + '%' }" /></div>
        <div class="scan-meta">
          <span v-if="scan.status === 'running'">扫描进行中 · {{ scan.total.toLocaleString() }} 只 · {{ stageLabel }}</span>
          <span v-else-if="scan.status === 'completed'">扫描完成 · {{ scan.finishedAt ? new Date(scan.finishedAt).toLocaleString('zh-CN', { hour12: false }) : '' }}</span>
          <span v-else>扫描失败</span>
          <span>成功 {{ (scan.counts.succeeded ?? 0).toLocaleString() }} · 历史不足 {{ (scan.counts.insufficient_history ?? 0).toLocaleString() }} · 失败 {{ (scan.counts.failed_terminal ?? 0).toLocaleString() }} · 待处理 {{ (scan.counts.pending ?? 0).toLocaleString() }}</span>
          <button v-if="(scan.counts.failed_terminal ?? 0) > 0 && scan.status !== 'running'" class="retry" :disabled="busy" @click="retryFailed">重试失败 {{ (scan.counts.failed_terminal ?? 0).toLocaleString() }}</button>
        </div>
      </div>

      <div v-if="overview.research" class="snapshot-note"><AppIcon name="info" /><span>研究快照已发布（{{ new Date(overview.research.createdAt).toLocaleString('zh-CN', { hour12: false }) }}）：{{ overview.research.ready.toLocaleString() }} 只有效评分，{{ overview.research.failed.toLocaleString() }} 只进入诊断。排名清单在下方“共振观察清单”按分页加载。</span></div>
      <div v-if="error" class="error-banner" role="alert"><AppIcon name="info" />{{ error }}</div>
      <div class="market-token">
        <label><span class="sr-only">管理令牌</span><input v-model="token" type="password" placeholder="管理令牌（同步 / 扫描需要）" autocomplete="off" @change="saveToken" /></label>
        <span v-if="!token">本地开发：启动时传入 --research-token，或在此填入</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { SyncSourceState } from '../../server/storage/researchStore';
import type { ScanSummary } from '../../server/storage/researchStore';
import { useCatalogOverview } from '../composables/useCatalogOverview';
import { rankRawEntries } from '../domain/resonance';
import AppIcon from './AppIcon.vue';

type PagedSourceId = 'sse_main' | 'sse_star' | 'szse_stocks' | 'szse_etf';

const PAGED_SOURCES: PagedSourceId[] = ['sse_main', 'sse_star', 'szse_stocks', 'szse_etf'];

const { overview, refresh } = useCatalogOverview();
const busy = ref(false);
const scanning = ref(false);
const syncing = ref(false);
const staging = ref(false);
const finalizePhase = ref(false);
const scan = ref<ScanSummary | null>(null);
const syncStates = ref<SyncSourceState[]>([]);
const error = ref('');
const token = ref('');
let stop = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;

const marketLabels = { CN: 'A股', HK: '港股', US: '美股' } as const;

const syncLabel = computed(() => syncing.value ? (staging.value ? '暂存港交所目录…' : '同步目录中…') : '同步目录');
const scanLabel = computed(() => !scan.value || scan.value.status !== 'running' ? '启动全市场扫描' : finalizePhase.value ? '封口评分中…' : `扫描中 ${((scan.value.total - (scan.value.counts.pending ?? 0) - (scan.value.counts.running ?? 0)) / Math.max(1, scan.value.total) * 100).toFixed(0)}%`);
const stageLabel = computed(() => finalizePhase.value ? '正在汇总评分' : overview.value.driver === 'client' ? '按批次推进' : '服务端执行中');
const progressPercent = computed(() => scan.value ? Math.min(100, Math.round((scan.value.total - (scan.value.counts.pending ?? 0) - (scan.value.counts.running ?? 0)) / Math.max(1, scan.value.total) * 100)) : 0);

const sourceLabels: Record<string, string> = { sse_main: '上交所主板', sse_star: '科创板', szse_stocks: '深交所股票', szse_etf: '深交所ETF', nasdaq_stocks: '美国股票', nasdaq_etf: '美国ETF', hkex: '港交所' };
const sourceLabel = (source: string) => sourceLabels[source] ?? source;

function headers(): Record<string, string> {
  return token.value ? { 'x-admin-token': token.value } : {};
}
function saveToken(): void {
  try { localStorage.setItem('chan-admin-token', token.value); } catch { /* ignore */ }
}
function loadToken(): void {
  try { token.value = localStorage.getItem('chan-admin-token') ?? ''; } catch { /* ignore */ }
}

async function syncCatalog(): Promise<void> {
  error.value = '';
  busy.value = true;
  syncing.value = true;
  try {
    const start = await fetch('/api/catalog/sync', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
    if (start.error) throw new Error(String(start.error));
    if (start.mode !== 'paged') { await refresh(); return; } // server driver: full sync done in request
    await runPagedSync();
  } catch (e) { error.value = e instanceof Error ? e.message : '目录同步失败'; }
  finally { syncing.value = false; staging.value = false; busy.value = false; await refresh().then(loadStates); }
}

async function runPagedSync(): Promise<void> {
  const failures: string[] = [];
  for (const source of PAGED_SOURCES) {
    let cursor: string | null = null;
    let retries = 0;
    // One source failing (e.g. exchange WAF from this network) must not abort the others:
    // retry with backoff, then record the failure and continue.
    while (!stop) {
      const body: { source: PagedSourceId; cursor: string | null } = { source, cursor };
      const response = await fetch('/api/catalog/sync/page', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then((r) => r.json())
        .catch(() => ({ ok: false, error: '目录分页请求失败' }) as { ok: false; error: string });
      if (response.ok) {
        retries = 0;
        syncStates.value = mergeState(syncStates.value, (response as { state?: SyncSourceState }).state);
        cursor = (response as { nextCursor?: string | null }).nextCursor ?? null;
        if (!cursor) break;
        continue;
      }
      const failed = response as { error?: string; state?: SyncSourceState };
      if (failed.state) syncStates.value = mergeState(syncStates.value, failed.state);
      if (retries < 2) {
        retries += 1;
        await new Promise((resolve) => setTimeout(resolve, 700 * retries));
        continue;
      }
      failures.push(`${sourceLabel(source)}：${failed.error ?? '分页同步失败'}`);
      break;
    }
    if (stop) return;
  }
  // Nasdaq: single-shot download proxied unparsed and parsed in the browser —
  // its paged endpoint orders rows non-deterministically, so offset windows
  // both duplicate and miss symbols.
  for (const kind of ['stocks', 'etf'] as const) {
    if (stop) return;
    const source: 'nasdaq_stocks' | 'nasdaq_etf' = kind === 'stocks' ? 'nasdaq_stocks' : 'nasdaq_etf';
    try {
      const upstream = await fetch(`/api/catalog/nasdaq-screener?kind=${kind}`);
      if (!upstream.ok) throw new Error((await upstream.json()).error ?? 'Nasdaq目录获取失败');
      const root = await upstream.json();
      const { parseNasdaqScreener } = await import('../../shared/nasdaqScreener');
      const parsed = parseNasdaqScreener(kind, root);
      for (let i = 0; i < parsed.instruments.length; i += 1000) {
        const chunk = await fetch('/api/catalog/stage', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ rows: parsed.instruments.slice(i, i + 1000), ...(i === 0 ? { declaredTotal: parsed.declaredTotal } : {}), done: i + 1000 >= parsed.instruments.length }) }).then((r) => r.json());
        if (!chunk.ok) throw new Error(chunk.error ?? 'Nasdaq目录暂存失败');
        syncStates.value = mergeState(syncStates.value, chunk.state);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Nasdaq目录同步失败';
      failures.push(`${sourceLabel(source)}：${message}`);
      const reported = await fetch('/api/catalog/sync-fail', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ source, error: message }) }).then((r) => r.json()).catch(() => null);
      if (reported?.ok) syncStates.value = mergeState(syncStates.value, reported.state);
    }
  }
  // HKEX workbook: heavy XLSX parse happens in the browser.
  staging.value = true;
  try {
    const upstream = await fetch('/api/catalog/hkex-workbook');
    if (!upstream.ok) throw new Error((await upstream.json()).error ?? '港交所目录获取失败');
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(await upstream.arrayBuffer(), { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
    const { parseHkexWorkbookRows } = await import('../../shared/hkexWorkbook');
    const instruments = parseHkexWorkbookRows(rows);
    const updated = (await fetch('/api/catalog/stage', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ rows: instruments.slice(0, 1000), declaredTotal: instruments.length, done: instruments.length <= 1000, sourceDate: rows[1] ? String(rows[1][0] ?? '') : null }) }).then((r) => r.json()));
    if (!updated.ok) throw new Error(updated.error ?? '港交所目录暂存失败');
    syncStates.value = mergeState(syncStates.value, updated.state);
    for (let i = 1000; i < instruments.length; i += 1000) {
      const chunk = await fetch('/api/catalog/stage', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ rows: instruments.slice(i, i + 1000), done: i + 1000 >= instruments.length }) }).then((r) => r.json());
      if (!chunk.ok) throw new Error(chunk.error ?? '港交所目录暂存失败');
      syncStates.value = mergeState(syncStates.value, chunk.state);
    }
  } catch (e) {
    // Report the workbook failure so commit knows HKEX is missing, then still commit the rest.
    const message = e instanceof Error ? e.message : '港交所目录同步失败';
    failures.push(`港交所：${message}`);
    const reported = await fetch('/api/catalog/sync-fail', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ source: 'hkex', error: message }) }).then((r) => r.json()).catch(() => null);
    if (reported?.ok) syncStates.value = mergeState(syncStates.value, reported.state);
  } finally { staging.value = false; }
  const commit = await fetch('/api/catalog/commit', { method: 'POST', headers: headers() }).then((r) => r.json());
  if (!commit.ok) throw new Error(commit.error ?? '目录提交失败');
  if (failures.length) throw new Error(`部分来源未同步（目录未封口）：${failures.join('；')}`);
}

function mergeState(list: SyncSourceState[], state: SyncSourceState | undefined): SyncSourceState[] {
  if (!state) return list;
  const index = list.findIndex((item) => item.source === state.source);
  const next = [...list];
  if (index >= 0) next[index] = state; else next.push(state);
  return next;
}

async function loadStates(): Promise<void> {
  const body = await fetch('/api/catalog/sync-state').then((r) => r.json());
  if (body.ok) syncStates.value = body.states ?? [];
}

async function startScan(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    const body = await fetch('/api/scans', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
    if (body.error) throw new Error(String(body.error));
    scan.value = body.scan;
    if (body.driver === 'client') { stop = false; void clientScanLoop(); }
    else startPolling();
  } catch (e) { error.value = e instanceof Error ? e.message : '扫描启动失败'; busy.value = false; }
}

/** Dashboard-driven scan ('client' driver): steps, ranking, score upload, and finalize. */
async function clientScanLoop(): Promise<void> {
  try {
    scanning.value = true;
    while (scan.value && scan.value.status === 'running' && !stop) {
      const step = await fetch(`/api/scans/${scan.value.id}/step`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ limit: 10 }) }).then((r) => r.json());
      if (step.error) throw new Error(String(step.error));
      if (!step.scan) break;
      scan.value = step.scan as ScanSummary;
      if ((scan.value.counts.pending ?? 1) === 0 && (scan.value.counts.running ?? 0) === 0) break;
    }
    if (scan.value && scan.value.status === 'running' && !stop) await finalizeScores(scan.value.id);
  } catch (e) { error.value = e instanceof Error ? e.message : '扫描推进失败'; }
  finally { scanning.value = false; busy.value = false; await refresh(); }
}

async function finalizeScores(scanId: string): Promise<void> {
  finalizePhase.value = true;
  try {
    // 1. Pull compact scoring inputs (instrument id + chan score + momentum raw).
    const raws: { instrumentId: string; name: string; market: 'CN' | 'HK' | 'US'; kind: 'stock' | 'etf'; chanScore: number; raw: number }[] = [];
    let cursor = 0;
    for (;;) {
      const page = await fetch(`/api/scans/${scanId}/raws?cursor=${cursor}&limit=5000`).then((r) => r.json());
      if (!page.ok) throw new Error('评分数据读取失败');
      raws.push(...page.page.rows);
      if (page.page.nextCursor === null) break;
      cursor = page.page.nextCursor;
    }
    // 2. Rank client-side with the same pure function the server uses.
    const scores = rankRawEntries(raws);
    // 3. Upload scores in bounded chunks.
    for (let i = 0; i < scores.length; i += 500) {
      const response = await fetch(`/api/scans/${scanId}/scores`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ scores: scores.slice(i, i + 500) }) }).then((r) => r.json());
      if (!response.ok) throw new Error(response.error ?? '评分回写失败');
    }
    // 4. Close the snapshot (server validates closure).
    const finalize = await fetch(`/api/scans/${scanId}/finalize`, { method: 'POST', headers: headers() }).then((r) => r.json());
    if (finalize.error) throw new Error(String(finalize.error));
    scan.value = finalize.scan ?? scan.value;
  } finally { finalizePhase.value = false; }
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!scan.value || scan.value.status !== 'running') { if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; } await refresh(); return; }
    const body = await fetch(`/api/scans/${scan.value.id}`).then((r) => r.json());
    if (body.ok) scan.value = body.scan;
  }, 3000);
}

async function retryFailed(): Promise<void> {
  if (!scan.value) return;
  busy.value = true;
  error.value = '';
  try {
    const body = await fetch(`/api/scans/${scan.value.id}/retry`, { method: 'POST', headers: headers() }).then((r) => r.json());
    if (body.error) throw new Error(String(body.error));
    scan.value = body.scan;
    if (overview.value.driver === 'client') { stop = false; void clientScanLoop(); } else startPolling();
  } catch (e) { error.value = e instanceof Error ? e.message : '重试失败'; }
}

onMounted(() => {
  loadToken();
  void refresh().then((ov) => {
    // Re-adopt an already-running scan after reload so progress and resume keep working.
    if (!scan.value && ov.latestScan) scan.value = ov.latestScan;
    if (scan.value?.status === 'running' && !scanning.value) {
      if (ov.driver === 'client') { stop = false; void clientScanLoop(); } else startPolling();
    }
    return loadStates();
  });
});
onBeforeUnmount(() => { stop = true; if (pollTimer) clearInterval(pollTimer); });
</script>
