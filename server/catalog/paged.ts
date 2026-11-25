import type { CatalogInstrument } from '../../shared/catalog.ts';
import { cleanText, fetchCatalogJson, record } from './types.ts';

export type PagedSource = 'sse_main' | 'sse_star' | 'szse_stocks' | 'szse_etf';

export interface PagedResult {
  source: PagedSource;
  rows: CatalogInstrument[];
  declaredTotal: number | null;
  pageCount: number | null;
  fetchedCount: number;
  excludedCount: number;
  nextCursor: string | null;
}

interface PageContext {
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Fetch exactly one page per source so each catalog request stays well within
 * the dashboard loops cursors until nextCursor is null.
 */
export async function fetchCatalogPage(source: PagedSource, cursor: string | null, context: PageContext): Promise<PagedResult> {
  const page = cursor ? Number(cursor) : 0;
  if (!Number.isInteger(page) || page < 0) throw new Error('目录游标无效');
  if (source.startsWith('sse')) return fetchSse(source, page, context);
  if (source.startsWith('szse')) return fetchSzse(source, page, context);
  // Nasdaq is not paged: its screener order is non-deterministic between
  // requests, so it goes through /api/catalog/nasdaq-screener (full download).
  throw new Error('不支持的分页目录来源');
}

async function fetchSse(source: PagedSource, page: number, context: PageContext): Promise<PagedResult> {
  const stockType = source === 'sse_main' ? '1' : '8';
  const params = new URLSearchParams({ isPagination: 'true', stockCode: '', csrcCode: '', areaName: '', stockType, 'pageHelp.pageSize': '100', 'pageHelp.pageNo': String(page + 1), 'pageHelp.beginPage': String(page + 1), 'pageHelp.cacheSize': '1', 'pageHelp.endPage': String(page + 1) });
  const root = record(await fetchCatalogJson(new URL(`https://query.sse.com.cn/security/stock/getStockListData2.do?${params}`), context, { referer: 'https://www.sse.com.cn/' }));
  const pageHelp = record(root.pageHelp);
  const declaredTotal = Number(pageHelp.total);
  const rows = Array.isArray(root.result) ? root.result : [];
  if (!rows.length && page > 0) return { source, rows: [], declaredTotal, pageCount: null, fetchedCount: 0, excludedCount: 0, nextCursor: null };
  const instruments = rows.map((row) => {
    const item = record(row);
    const symbol = cleanText(item.SECURITY_CODE_A);
    if (!/^\d{6}$/.test(symbol)) throw new Error('上交所目录证券代码无效');
    const board = stockType === '1' ? 'SSE' : 'STAR';
    return { id: `CN:${symbol}`, symbol, name: cleanText(item.SECURITY_ABBR_A), market: 'CN' as const, kind: 'stock' as const, currency: 'CNY' as const, exchange: board, providers: { eastmoney: `1.${symbol}`, tencent: `sh${symbol}` }, listingStatus: 'listed' as const, listedAt: cleanText(item.LISTING_DATE) || null, catalogSource: 'sse' as const, catalogVersion: 'pending', mappingStatus: 'ready' as const };
  });
  const pageCount = Math.ceil(declaredTotal / 100);
  return { source, rows: instruments as CatalogInstrument[], declaredTotal, pageCount, fetchedCount: rows.length, excludedCount: 0, nextCursor: page + 1 < pageCount ? String(page + 1) : null };
}

async function fetchSzse(source: PagedSource, page: number, context: PageContext): Promise<PagedResult> {
  const catalogId = source === 'szse_stocks' ? '1110' : '1105';
  const url = new URL(`https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=${catalogId}&TABKEY=tab1&PAGENO=${page + 1}`);
  const root = await fetchCatalogJson(url, context, { referer: 'https://www.szse.cn/' });
  if (!Array.isArray(root)) throw new Error('深交所目录响应无效');
  const tab = root.map(record).find((item) => record(item.metadata).tabkey === 'tab1');
  if (!tab) throw new Error('深交所目录缺少目标页');
  const metadata = record(tab.metadata);
  const declaredTotal = Number(metadata.recordcount);
  const pageCount = Number(metadata.pagecount);
  const rows = Array.isArray(tab.data) ? tab.data : [];
  const instruments: CatalogInstrument[] = [];
  let excluded = 0;
  for (const row of rows) {
    const item = record(row);
    const symbol = cleanText(source === 'szse_stocks' ? item.agdm : item.sys_key);
    if (!/^\d{6}$/.test(symbol)) throw new Error('深交所目录证券代码无效');
    const isEtf = source === 'szse_etf';
    if (isEtf && cleanText(item.jjlb) !== 'ETF') { excluded++; continue; }
    instruments.push({ id: `CN:${symbol}`, symbol, name: cleanText(isEtf ? item.jjjcurl : item.agjc), market: 'CN', kind: isEtf ? 'etf' : 'stock', currency: 'CNY', exchange: 'SZSE', providers: { eastmoney: `0.${symbol}`, tencent: `sz${symbol}` }, listingStatus: 'listed', listedAt: cleanText(isEtf ? item.ssrq : item.agssrq) || null, catalogSource: 'szse', catalogVersion: 'pending', mappingStatus: 'ready' });
  }
  return { source, rows: instruments, declaredTotal, pageCount, fetchedCount: rows.length, excludedCount: excluded, nextCursor: page + 1 < pageCount ? String(page + 1) : null };
}

export function isPagedSource(value: string): value is PagedSource {
  return ['sse_main', 'sse_star', 'szse_stocks', 'szse_etf'].includes(value);
}
