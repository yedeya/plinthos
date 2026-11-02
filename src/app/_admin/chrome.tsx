/**
 * The frame every admin page, the entry form and the offline shell share (`docs/design/ui.md`):
 * the header, with the page's title, a way back, and the status chip that keeps the queue's
 * state in view, and under it the word on the public catalogue after a synced delete ([PUB-16]).
 * It renders on the server and in the static shell alike: it reads nothing but its props, and the
 * chip and the word read only what the device itself keeps, in the browser.
 */
import type { ReactNode } from 'react';
import { StatusChip, SyncedCatalogueNotice } from '../_offline/client';

export function Header({ title, back }: { readonly title: string; readonly back?: { readonly href: string; readonly label: string } }) {
  return (
    <>
      <header className="header">
        {back === undefined ? null : (
          <a className="header__back" href={back.href}>
            {back.label}
          </a>
        )}
        <h1 className="header__title">{title}</h1>
        <StatusChip />
      </header>
      <SyncedCatalogueNotice />
    </>
  );
}

/** The page's one column. */
export function Page({ children }: { readonly children: ReactNode }) {
  return <main className="page">{children}</main>;
}
