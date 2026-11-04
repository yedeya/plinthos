'use client';

/**
 * Sets the page's document title in the browser (#255, [EXP-5]): browsers name a saved PDF after
 * it, so the printable catalogue's says what it is and when it was made. A page under `/admin` may
 * export no `generateMetadata`, which Next.js runs outside the admin check ([AUTH-3]'s route test),
 * so the server passes the title here instead. It is set again just before printing, in case
 * anything replaced it since.
 */
import { useEffect } from 'react';

export function DocumentTitle({ title }: { readonly title: string }) {
  useEffect(() => {
    const previous = document.title;
    const apply = () => {
      document.title = title;
    };
    apply();
    window.addEventListener('beforeprint', apply);
    return () => {
      window.removeEventListener('beforeprint', apply);
      document.title = previous;
    };
  }, [title]);
  return null;
}
