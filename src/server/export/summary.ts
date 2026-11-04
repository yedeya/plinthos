/**
 * The printable catalogue's figures, sections and title ([EXP-5], #236, #255), from the
 * catalogue's data alone: pure, so the page and `[PUB-4]`'s canary test compute them the same way. Every figure is one the data holds
 * or a count of it, so the summary says no more than the catalogue would: an amount only where the
 * data has one, which the projection gives only when the settings show it ([PUB-17], [PUB-18]).
 */
import type { PublicCatalogueData, PublicItem, PublicSegment } from '../publish/catalogue-data';
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

/** One segment of the printable catalogue's item list (#255): its items in the data's order, and the loose parts' counts in `parts`. */
export interface CatalogueSection {
  readonly segment: PublicSegment;
  readonly items: readonly PublicItem[];
  /** The loose parts' lots and parts, a count line rather than rows: only in `parts`, when any are imported. */
  readonly parts: { readonly lots: number; readonly quantity: number } | null;
}

/**
 * Every item the catalogue shows, grouped by segment as the catalogue groups them (`segmentOf`,
 * [VAL-7]): sealed, used, then the bulk lots with the loose parts. A segment with nothing in it
 * is left out; no item is left out or listed twice.
 */
export function catalogueSections(data: PublicCatalogueData): CatalogueSection[] {
  const parts = summaryFigures(data).parts;
  return ORDER.flatMap((segment): CatalogueSection[] => {
    const items = data.items.filter((item) => segmentOf(item) === segment);
    const counts = segment === 'parts' && parts !== null ? { lots: parts.lots, quantity: parts.quantity } : null;
    return items.length === 0 && counts === null ? [] : [{ segment, items, parts: counts }];
  });
}

/**
 * When the data was made, as the printable catalogue's document title writes it (#255), such as
 * `2026-11-03 22.09`: in UTC, as the page's "Made" line is, because the deployment configures no
 * time zone; a dot between the hour and the minute, because a file name can't hold a colon.
 */
export function fileStamp(iso: string): string {
  const at = new Date(iso).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 13)}.${at.slice(14, 16)}`;
}

/** A title made safe for a file name: no slash, colon or other character a file system refuses, and never empty. */
export function fileSafe(title: string, fallback: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
}
