'use client';
/**
 * The item list on `/admin` ([ITEM-8]): the owner's items as the server lists them, newest first,
 * each with a thumbnail (by default the set's stock image from the catalogue, else its cover
 * thumbnail through a presigned URL, else an empty tile), its set number, name, condition and
 * quantity, and above them the items still in this device's queue, marked as not synced. A
 * minifigure, bulk lot or other item (#202) shows its own name and a small kind label, and never a
 * stock image. The text filter narrows both by set number, name, reference number, theme or
 * top-level theme as the owner types, and the filters behind **Filters** by theme, condition,
 * completeness, instructions, kind and what needs attention, each option with its count, beside
 * a sort by date added, value or year (#251, [ITEM-14] to [ITEM-19], `./item-filters.ts`). All of
 * it runs in the browser over what the page loaded and sends no request, and it is kept in the
 * page's query string ([ITEM-18]). A tap opens the item in the entry form.
 *
 * The queued items come from the device's own queue, in the browser, never from the server.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { itemLabel, queuedItems, type ItemKind, type ListedItem, type QueuedItem } from '../_offline/items';
import { useQueueState, useReloadWhenSynced } from '../_offline/client';
import { en } from '../messages/en';
import {
  activeFilterCount,
  filterOptions,
  listedSubject,
  matchesView,
  NO_FILTERS,
  optionCounts,
  queuedSubject,
  readView,
  sortListed,
  SORTS,
  TEXT_MAX,
  THEME_UNKNOWN,
  themeOptions,
  viewQuery,
  type FilterName,
  type ListFilters,
  type ListView,
} from './item-filters';
import { valueText } from './values';

/** The path an item is edited at. */
export function itemPath(id: string): string {
  return `/admin/items/${encodeURIComponent(id)}`;
}

function Marker({ queued }: { readonly queued: QueuedItem | undefined }) {
  if (queued === undefined) return null;
  if (queued.held) return <span className="chip chip--danger">{en.items.needsYou}</span>;
  return <span className="chip chip--warn">{queued.deleted ? en.items.deleting : en.items.notSynced}</span>;
}

/**
 * The row's thumbnail ([ITEM-8]): the set's stock image by default, else the owner's cover photo,
 * else an empty tile. Plain imgs: a presigned URL that Next.js's image optimizer must not fetch
 * or cache ([PHOTO-6]), and a catalogue image sent no referrer.
 */
function Thumb({ stock, cover, label }: { readonly stock: string | null; readonly cover: string | null; readonly label: string }) {
  if (stock !== null) return <img className="item-row__thumb" src={stock} alt={en.items.stockAlt(label)} referrerPolicy="no-referrer" width={56} height={56} loading="lazy" />;
  if (cover !== null) return <img className="item-row__thumb" src={cover} alt={en.items.coverAlt(label)} referrerPolicy="no-referrer" width={56} height={56} />;
  return <span className="item-row__thumb" role="img" aria-label={en.items.noCover} />;
}

/** A non-set's small kind label (#202); a set carries none. */
function KindLabel({ kind }: { readonly kind: ItemKind }) {
  return kind === 'SET' ? null : <span className="chip">{en.items.kind[kind]}</span>;
}

/** The row's name: a set's number and catalogue name, or a non-set's own name. */
function rowName(item: { readonly kind: ItemKind; readonly setNum: string | null; readonly name: string | null }): string {
  return item.kind === 'SET' ? [item.setNum, item.name].filter((part) => part !== null && part !== '').join(' ') : (item.name ?? '');
}

/** The list's summary: distinct sets, other items, and every item counted by its quantity. */
function summary(items: readonly { readonly kind: ItemKind; readonly setNum: string | null; readonly quantity: number }[]): string {
  const sets = new Set(items.flatMap((item) => (item.kind === 'SET' && item.setNum !== null ? [item.setNum] : []))).size;
  const others = items.filter((item) => item.kind !== 'SET').length;
  return en.items.summary(sets, others, items.reduce((sum, item) => sum + item.quantity, 0));
}

/** The query string as the page receives it. */
export type ListQuery = Readonly<Record<string, string | string[] | undefined>>;

/** Writes the view into the page's query string in place: no navigation and no request ([ITEM-18]). */
function useViewInQuery(view: ListView): void {
  useEffect(() => {
    const search = viewQuery(view);
    const { pathname, hash } = window.location;
    const next = `${pathname}${search === '' ? '' : `?${search}`}${hash}`;
    if (next !== `${pathname}${window.location.search}${hash}`) window.history.replaceState(null, '', next);
  }, [view]);
}

/** One filter's options as pills, each with its count; any chosen ones are the filter ([ITEM-14], [ITEM-17]). */
function FilterGroup<Option extends string>({
  legend,
  options,
  chosen,
  counts,
  label,
  onChange,
}: {
  readonly legend: string;
  readonly options: readonly Option[];
  readonly chosen: readonly Option[];
  readonly counts: ReadonlyMap<string, number>;
  readonly label: (option: Option) => string;
  readonly onChange: (chosen: Option[]) => void;
}) {
  if (options.length === 0) return null;
  return (
    <fieldset className="choices">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label className="choice" key={option}>
          <input
            type="checkbox"
            checked={chosen.includes(option)}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              // Kept in the options' order, so the query string is the same however it was tapped.
              onChange(options.filter((other) => (other === option ? on : chosen.includes(other))));
            }}
          />
          <span className="choice__label">{label(option)}</span> <span className="choice__count">{counts.get(option) ?? 0}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The filter controls and the sort ([ITEM-14] to [ITEM-17]), behind one **Filters** button that
 * shows how many filters are on, so on a phone the list still starts near the top.
 */
function Filters({ view, themes, counts, onChange }: { readonly view: ListView; readonly themes: readonly string[]; readonly counts: ReturnType<typeof optionCounts>; readonly onChange: (view: ListView) => void }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const t = en.items.filters;
  const on = activeFilterCount(view.filters);
  const options = filterOptions(themes);
  const set = <F extends FilterName>(filter: F) => (chosen: ListFilters[F]) => onChange({ ...view, filters: { ...view.filters, [filter]: chosen } });
  return (
    <>
      <button type="button" className={on === 0 ? 'button' : 'button button--on'} aria-expanded={open} aria-controls={open ? panel : undefined} onClick={() => setOpen(!open)}>
        {t.button(on)}
      </button>
      {open ? (
        <div className="item-filters" id={panel} role="group" aria-label={t.panelLabel}>
          <fieldset className="choices">
            <legend>{t.sort}</legend>
            {SORTS.map((sort) => (
              <label className="choice" key={sort}>
                <input type="radio" name={`${panel}-sort`} checked={view.sort === sort} onChange={() => onChange({ ...view, sort })} />
                <span className="choice__label">{t.sortOptions[sort]}</span>
              </label>
            ))}
          </fieldset>
          <FilterGroup legend={t.theme} options={options.theme} chosen={view.filters.theme} counts={counts.theme} label={(theme) => (theme === THEME_UNKNOWN ? t.themeUnknown : theme)} onChange={set('theme')} />
          <FilterGroup legend={t.condition} options={options.condition} chosen={view.filters.condition} counts={counts.condition} label={(condition) => en.condition[condition]} onChange={set('condition')} />
          <FilterGroup legend={t.complete} options={options.complete} chosen={view.filters.complete} counts={counts.complete} label={(answer) => t.yesNo[answer]} onChange={set('complete')} />
          <FilterGroup legend={t.instructions} options={options.instructions} chosen={view.filters.instructions} counts={counts.instructions} label={(answer) => t.yesNo[answer]} onChange={set('instructions')} />
          <FilterGroup legend={t.kind} options={options.kind} chosen={view.filters.kind} counts={counts.kind} label={(kind) => en.items.kind[kind]} onChange={set('kind')} />
          <FilterGroup legend={t.attention} options={options.attention} chosen={view.filters.attention} counts={counts.attention} label={(attention) => t.attentionOptions[attention]} onChange={set('attention')} />
          {on === 0 ? null : (
            <button type="button" className="button button--link" onClick={() => onChange({ ...view, filters: { ...NO_FILTERS, text: view.filters.text } })}>
              {t.clear}
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

export function ItemList({ items, query = {} }: { readonly items: readonly ListedItem[]; readonly query?: ListQuery }) {
  const themes = useMemo(() => themeOptions(items), [items]);
  const [view, setView] = useState(() => readView(query, themes));
  useViewInQuery(view);
  const { entries } = useQueueState();
  useReloadWhenSynced();
  const queued = queuedItems(entries);
  const queuedById = new Map(queued.map((item) => [item.id, item]));
  const stored = new Set(items.map((item) => item.id));
  // A queued new item is filtered on what the queue holds; a queued change to a stored item as the stored item ([ITEM-19]).
  const fresh = queued.filter((item) => !stored.has(item.id) && !item.deleted);
  const subjects = [...fresh.map(queuedSubject), ...items.map(listedSubject)];
  const counts = optionCounts(subjects, view.filters, themes);
  const onDevice = fresh.filter((item) => matchesView(queuedSubject(item), view.filters));
  // The queued items stay above the list in the queue's order; the sort orders the stored ones ([ITEM-16]).
  const listed = sortListed(
    items.filter((item) => matchesView(listedSubject(item), view.filters)),
    view.sort,
  );
  const everything = [...items, ...fresh];

  return (
    <section className="section" aria-label={en.items.listLabel}>
      <div className="item-tools">
        <label className="field item-tools__search">
          <span className="visually-hidden">{en.items.filterLabel}</span>
          <input
            className="input"
            type="search"
            placeholder={en.items.filterPlaceholder}
            value={view.filters.text}
            maxLength={TEXT_MAX}
            onChange={(event) => setView({ ...view, filters: { ...view.filters, text: event.currentTarget.value } })}
            autoComplete="off"
          />
        </label>
        <Filters view={view} themes={themes} counts={counts} onChange={setView} />
      </div>
      {everything.length === 0 ? (
        <p className="muted">{en.items.empty}</p>
      ) : onDevice.length + listed.length === 0 ? (
        <p className="muted">{en.items.noMatch}</p>
      ) : (
        <ul className="item-list">
          {onDevice.map((item) => (
            <li key={`queued-${item.id}`}>
              <div className="item-row">
                <Thumb stock={null} cover={null} label={itemLabel(item)} />
                <span className="item-row__text">
                  <span className="item-row__name">{rowName(item)}</span>
                  <span className="muted">{en.items.meta(item.condition, item.quantity)}</span>
                </span>
                <KindLabel kind={item.kind} />
                <Marker queued={item} />
              </div>
            </li>
          ))}
          {listed.map((item) => (
            <li key={item.id}>
              <a className="item-row" href={itemPath(item.id)}>
                {/* The stock image is a set's alone (#202). */}
                <Thumb stock={item.kind === 'SET' ? item.stockImageUrl : null} cover={item.coverThumbnailUrl} label={itemLabel(item)} />
                <span className="item-row__text">
                  <span className="item-row__name">{rowName(item)}</span>
                  <span className="muted">{en.items.meta(item.condition, item.quantity)}</span>
                  {/* The value, private to the admin, with its source and date ([VAL-7]); a list given none shows none. */}
                  {item.value === undefined ? null : <span className="muted item-row__value">{valueText(item.value)}</span>}
                </span>
                <KindLabel kind={item.kind} />
                <Marker queued={queuedById.get(item.id)} />
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        {summary(everything)}
      </p>
    </section>
  );
}

/**
 * The items still in this device's queue, alone: what the offline shell lists, since it holds no
 * server data ([SYNC-6]). Nothing is shown while the queue holds no item.
 */
export function QueuedItemList({ title }: { readonly title: string }) {
  const { entries } = useQueueState();
  const queued = queuedItems(entries).filter((item) => !item.deleted);
  if (queued.length === 0) return null;
  return (
    <section className="section" aria-label={title}>
      <h2>{title}</h2>
      <ul className="item-list">
        {queued.map((item) => (
          <li key={item.id}>
            <div className="item-row">
              <Thumb stock={null} cover={null} label={itemLabel(item)} />
              <span className="item-row__text">
                <span className="item-row__name">{rowName(item)}</span>
                <span className="muted">{en.items.meta(item.condition, item.quantity)}</span>
              </span>
              <KindLabel kind={item.kind} />
              <Marker queued={item} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
