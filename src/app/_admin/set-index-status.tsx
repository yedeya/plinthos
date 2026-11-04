'use client';
/**
 * The set index's age on `/admin` ([CAT-10]): when the index on this device was built, and a quiet
 * line when it is older than 14 days, two missed weekly builds, which is how a build that keeps
 * failing shows up without an alarm (brief #252, §5). Opening `/admin` online asks the index's
 * route once (`checkSetIndexOnce`), and the line follows a newer index once it is stored.
 *
 * It reads only the device's own copy, in the browser, so the server renders nothing for it.
 */
import { useEffect, useState } from 'react';
import { checkSetIndexOnce, isStale, readIndexMeta, SET_INDEX_CHANGED, type StoredIndexMeta } from '../_offline/set-index';
import { en } from '../messages/en';

export function SetIndexStatus() {
  /** Undefined until the device's copy has been read; null when it holds none. */
  const [meta, setMeta] = useState<StoredIndexMeta | null | undefined>(undefined);
  useEffect(() => {
    if (typeof indexedDB === 'undefined') return;
    let live = true;
    const read = () =>
      void readIndexMeta().then(
        (found) => live && setMeta(found),
        () => live && setMeta(null),
      );
    read();
    window.addEventListener(SET_INDEX_CHANGED, read);
    void checkSetIndexOnce();
    return () => {
      live = false;
      window.removeEventListener(SET_INDEX_CHANGED, read);
    };
  }, []);
  if (meta === undefined) return null;
  const m = en.setIndex;
  return (
    <p className="muted">
      {meta === null ? m.none : m.builtOn(meta.builtAt)}
      {meta !== null && isStale(meta.builtAt) ? ` ${m.stale}` : null}
    </p>
  );
}
