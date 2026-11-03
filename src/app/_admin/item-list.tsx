'use client';
/**
 * The item list on `/admin` ([ITEM-8]): the owner's items as the server lists them, newest first,
 * each with a thumbnail (by default the set's stock image from the catalogue, else its cover
 * thumbnail through a presigned URL, else an empty tile), its set number, name, condition and
 * quantity, and above them the items still in this device's queue, marked as not synced. A
 * minifigure, bulk lot or other item (#202) shows its own name and a small kind label, and never a
 * stock image. The filter narrows both by set number, name or reference number as the owner
 * types. A tap opens the item in the entry form.
 *
 * The queued items come from the device's own queue, in the browser, never from the server.
 */
import { useState } from 'react';
import { itemLabel, matchesFilter, queuedItems, type ItemKind, type ListedItem, type QueuedItem } from '../_offline/items';
import { useQueueState, useReloadWhenSynced } from '../_offline/client';
import { en } from '../messages/en';
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

export function ItemList({ items }: { readonly items: readonly ListedItem[] }) {
  const [filter, setFilter] = useState('');
  const { entries } = useQueueState();
  useReloadWhenSynced();
  const queued = queuedItems(entries);
  const queuedById = new Map(queued.map((item) => [item.id, item]));
  const stored = new Set(items.map((item) => item.id));
  const onDevice = queued.filter((item) => !stored.has(item.id) && !item.deleted && matchesFilter(item, filter));
  const listed = items.filter((item) => matchesFilter(item, filter));
  const everything = [...items, ...queued.filter((item) => !stored.has(item.id) && !item.deleted)];

  return (
    <section className="section" aria-label={en.items.listLabel}>
      <label className="field">
        <span className="visually-hidden">{en.items.filterLabel}</span>
        <input className="input" type="search" placeholder={en.items.filterPlaceholder} value={filter} onChange={(event) => setFilter(event.currentTarget.value)} autoComplete="off" />
      </label>
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
