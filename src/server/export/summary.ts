/**
 * The printable summary's figures ([EXP-5], #236), from the catalogue's data alone: pure, so the
 * page and `[PUB-4]`'s canary test compute them the same way. Every figure is one the data holds
 * or a count of it, so the summary says no more than the catalogue would: an amount only where the
 * data has one, which the projection gives only when the settings show it ([PUB-17], [PUB-18]).
 */
import type { PublicCatalogueData, PublicSegment } from '../publish/catalogue-data';
import { segmentOf } from '../valuation/values';

export interface SummarySegment {
  readonly segment: PublicSegment;
  /** The items in the segment, and their count by quantity. */
  readonly items: number;
  readonly units: number;
  /** The segment's market total, only when the data holds one. */
  readonly value?: number;
  /** The segment's asking price, only when the data holds one. */
  readonly asking?: number;
}

export interface CatalogueSummaryFigures {
  readonly segments: readonly SummarySegment[];
  /** The loose parts' lots and parts, when any are imported. */
  readonly parts: { readonly lots: number; readonly quantity: number; readonly value?: number } | null;
  /** The overall market total and asking price, each only when the data holds it. */
  readonly total?: number;
  readonly askingTotal?: number;
  /** The currency every amount is in, when one is. */
  readonly currency?: string;
}

const ORDER: readonly PublicSegment[] = ['sealed', 'used', 'parts'];

export function summaryFigures(data: PublicCatalogueData): CatalogueSummaryFigures {
  const segments = ORDER.flatMap((segment): SummarySegment[] => {
    const held = data.items.filter((item) => segmentOf(item) === segment);
    const hasParts = segment === 'parts' && data.parts !== null;
    const value = data.totals?.[segment];
    const asking = data.asking?.[segment];
    if (held.length === 0 && !hasParts && value === undefined && asking === undefined) return [];
    return [
      {
        segment,
        items: held.length,
        units: held.reduce((sum, item) => sum + item.quantity, 0),
        ...(value === undefined ? {} : { value }),
        ...(asking === undefined ? {} : { asking }),
      },
    ];
  });
  const parts = data.parts === null || (data.parts.lots === 0 && data.parts.quantity === 0) ? null : data.parts;
  return {
    segments,
    parts: parts === null ? null : { lots: parts.lots, quantity: parts.quantity, ...(parts.value === undefined ? {} : { value: parts.value }) },
    ...(data.totals === undefined ? {} : { total: data.totals.all }),
    ...(data.asking?.total === undefined ? {} : { askingTotal: data.asking.total }),
    ...(data.valueCurrency === undefined ? {} : { currency: data.valueCurrency }),
  };
}
