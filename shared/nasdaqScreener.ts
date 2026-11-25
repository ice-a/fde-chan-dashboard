import type { CatalogInstrument } from './catalog';

/**
 * Parse a Nasdaq screener `download=true` response (single request returns the
 * full list) into catalog instruments.
 *
 * The paged screener endpoint orders rows non-deterministically between
 * requests, so offset-window paging both duplicates and misses symbols — the
 * full download is the only reliable shape. The browser fetches this JSON via
 * the passthrough endpoint and parses it here (same pattern as the HKEX
 * workbook).
 */
export interface NasdaqScreenerParse {
  instruments: CatalogInstrument[];
  declaredTotal: number;
  fetchedCount: number;
  excludedCount: number;
}

export function parseNasdaqScreener(kind: 'stocks' | 'etf', root: unknown): NasdaqScreenerParse {
  const data = (root as { data?: unknown } | null)?.data;
  if (!data || typeof data !== 'object') throw new Error('Nasdaq目录响应缺少数据');
  // stocks: data.rows; etf: data.data.rows
  const rowsValue = kind === 'stocks'
    ? (data as { rows?: unknown }).rows
    : ((data as { data?: unknown }).data as { rows?: unknown } | undefined)?.rows;
  if (!Array.isArray(rowsValue) || !rowsValue.length) throw new Error('Nasdaq目录缺少记录');

  const instruments: CatalogInstrument[] = [];
  let excluded = 0;
  for (const raw of rowsValue) {
    if (!raw || typeof raw !== 'object') { excluded++; continue; }
    const item = raw as Record<string, unknown>;
    const symbol = clean(String(item.symbol ?? '')).toUpperCase().replace(/\s+/g, '');
    const name = clean(kind === 'stocks' ? String(item.name ?? '') : String(item.companyName ?? ''));
    if (!/^[A-Z0-9][A-Z0-9./^-]{0,19}$/.test(symbol) || !name) { excluded++; continue; }
    if (kind === 'stocks' && (!isCommonEquity(name) || symbol.includes('^') || symbol.includes('/'))) { excluded++; continue; }
    instruments.push({
      id: `US:${symbol}`, symbol, name, market: 'US', kind: kind === 'etf' ? 'etf' : 'stock',
      currency: 'USD', exchange: 'US_MAIN', providers: { nasdaq: symbol },
      listingStatus: 'listed', listedAt: clean(String(item.ipoyear ?? '')) || null,
      catalogSource: 'nasdaq', catalogVersion: 'pending', mappingStatus: 'ready',
    });
  }
  return { instruments, declaredTotal: rowsValue.length, fetchedCount: rowsValue.length, excludedCount: excluded };
}

function clean(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function isCommonEquity(name: string): boolean {
  return !/\b(warrant|warrants|right|rights|unit|units|preferred|preference|depositary shares each representing|notes|debentures|bond|baby bond)\b/i.test(name);
}
