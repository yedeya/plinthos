'use client';
/**
 * The item list on `/admin` ([ITEM-8]): the owner's items as the server lists them, newest first,
 * each with a thumbnail (by default the set's stock image from the catalogue, else its cover
 * thumbnail through a presigned URL, else an empty tile), its set number, name, condition and
 * quantity, and above them the items still in this device's queue, marked as not synced. A
 * minifigure, bulk lot or other item (#202) shows its own name and a small kind label, and never a
 * stock image. A tap opens the item in the entry form.
 *
 * The text filter narrows both by set number, name, reference number or theme as the owner
 * types, and the filters by theme, condition, completeness, instructions, kind and what needs
 * attention, each option with its count; the stored items sort by date added, value or year
 * (#251, [ITEM-14] to [ITEM-17], `./item-filters.ts`). It all runs here, over what the page
 * loaded, and sends no request. On a phone the filters sit behind one **Filters** button that
 * says how many are on, so the list still starts near the top. The state is kept in the query
 * string, written in place ([ITEM-18]).
 *
 * The queued items come from the device's own queue, in the browser, never from the server, and
 * are filtered on what the queue holds ([ITEM-19]).
 */
import { useEffect, useId, useState } from 'react';
import { itemLabel, queuedItems, type ItemKind, type ListedItem, type QueuedItem } from '../_offline/items';
import { useQueueState, useReloadWhenSynced } from '../_offline/client';
import { en } from '../messages/en';
import {
  chosenCount,
  DEFAULT_QUERY,
  FILTER_KEYS,
  filterOptions,
  isFiltered,
  listQueryString,
  matchesQuery,
  optionCounts,
  parseListQuery,
  sortItems,
  SORTS,
  themeOptions,
  toggleOption,
  UNKNOWN_THEME,
  type Filterable,
  type FilterKey,
  type ListQuery,
  type Sort,
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

/** A stored item as the filters read it. */
function storedFilterable(item: ListedItem): Filterable {
  return { ...item, hasValue: item.value !== undefined && item.value !== null };
}

/** A new queued item as the filters read it ([ITEM-19]): no theme, which matches every theme option, and no value. */
function queuedFilterable(item: QueuedItem): Filterable {
  return { ...item, theme: null, topTheme: undefined, hasValue: false };
}

/** An option's name on the page. */
function optionName(key: FilterKey, option: string): string {
  switch (key) {
    case 'theme':
      return option === UNKNOWN_THEME ? en.items.filters.themeUnknown : option;
    case 'condition':
      return en.condition[option as keyof typeof en.condition];
    case 'complete':
    case 'instructions':
      return en.items.filters.yesNo[option as keyof typeof en.items.filters.yesNo];
    case 'kind':
      return en.items.kind[option as ItemKind];
    case 'attention':
      return en.items.filters.attention[option as keyof typeof en.items.filters.attention];
  }
}

/**
 * The filters ([ITEM-14], [ITEM-15]): one group of checkbox pills per filter, each option with its
 * count ([ITEM-17]), shown at 0 and still choosable. The theme filter is left out while no set is
 * listed, since it would have no option.
 */
function FilterPanel({
  id,
  query,
  themes,
  counts,
  onChange,
}: {
  readonly id: string;
  readonly query: ListQuery;
  readonly themes: readonly string[];
  readonly counts: ReturnType<typeof optionCounts>;
  readonly onChange: (query: ListQuery) => void;
}) {
  const options = filterOptions(themes);
  return (
    <div className="filters" id={id} role="group" aria-label={en.items.filters.label}>
      {FILTER_KEYS.filter((key) => options[key].length > 0).map((key) => (
        <fieldset className={key === 'theme' ? 'choices filters__group filters__group--wide' : 'choices filters__group'} key={key}>
          <legend>{en.items.filters.legend[key]}</legend>
          {(options[key] as readonly string[]).map((option) => {
            const count = counts[key].get(option) ?? 0;
            const name = optionName(key, option);
            return (
              <label className="choice choice--small" key={option}>
                <input
                  type="checkbox"
                  checked={(query[key] as readonly string[]).includes(option)}
                  onChange={() => onChange(toggleOption(query, key, option as never, themes))}
                  aria-label={en.items.filters.optionLabel(name, count)}
                />
                <span>{name}</span>
                <span className="choice__count">{count}</span>
              </label>
            );
          })}
        </fieldset>
      ))}
      {chosenCount(query) === 0 ? null : (
        <div>
          <button type="button" className="button button--link" onClick={() => onChange({ ...DEFAULT_QUERY, text: query.text, sort: query.sort })}>
            {en.items.filters.clear}
          </button>
        </div>
      )}
    </div>
  );
}

export function ItemList({ items, query: initialQuery = '' }: { readonly items: readonly ListedItem[]; readonly query?: string }) {
  const themes = themeOptions(items.map(storedFilterable));
  // The query string as the page was opened with it: unknown values are dropped ([ITEM-18]).
  const [query, setQuery] = useState<ListQuery>(() => parseListQuery(initialQuery, themes));
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { entries } = useQueueState();
  useReloadWhenSynced();

  // The query string follows the list's state, in place: no navigation and no request ([ITEM-18]).
  useEffect(() => {
    const search = listQueryString(query);
    if (search === window.location.search) return;
    window.history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
  }, [query]);

  const queued = queuedItems(entries);
  const queuedById = new Map(queued.map((item) => [item.id, item]));
  const stored = new Set(items.map((item) => item.id));
  // A queued change to a stored item is filtered as the stored item, which is listed marked ([ITEM-19]).
  const newOnDevice = queued.filter((item) => !stored.has(item.id) && !item.deleted);
  const subjects = [...newOnDevice.map(queuedFilterable), ...items.map(storedFilterable)];
  const counts = optionCounts(subjects, query, themes);
  const onDevice = newOnDevice.filter((item) => matchesQuery(queuedFilterable(item), query));
  const listed = sortItems(
    items.filter((item) => matchesQuery(storedFilterable(item), query)),
    query.sort,
  );
  const everything = [...items, ...newOnDevice];
  const chosen = chosenCount(query);

  return (
    <section className="section" aria-label={en.items.listLabel}>
      <div className="list-tools">
        <label className="field list-tools__search">
          <span className="visually-hidden">{en.items.filterLabel}</span>
          <input
            className="input"
            type="search"
            placeholder={en.items.filterPlaceholder}
            value={query.text}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setQuery((current) => ({ ...current, text }));
            }}
            autoComplete="off"
          />
        </label>
        <div className="list-tools__row">
          <button
            type="button"
            className={chosen === 0 ? 'button' : 'button button--on'}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((was) => !was)}
          >
            {en.items.filters.button(chosen)}
          </button>
          <label className="list-tools__sort">
            <span className="visually-hidden">{en.items.filters.sortLabel}</span>
            <select
              className="input"
              value={query.sort}
              onChange={(event) => {
                const sort = event.currentTarget.value as Sort;
                setQuery((current) => ({ ...current, sort }));
              }}
            >
              {SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {en.items.filters.sort[sort]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {open ? <FilterPanel id={panelId} query={query} themes={themes} counts={counts} onChange={setQuery} /> : null}
      {isFiltered(query) && everything.length > 0 ? (
        <p className="muted" aria-live="polite">
          {en.items.filters.shown(onDevice.length + listed.length, everything.length)}
        </p>
      ) : null}
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
