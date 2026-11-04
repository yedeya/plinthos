/**
 * The frame every admin page, the entry form and the offline shell share (`docs/design/ui.md`):
 * the header, with the page's title, a way back that leaves as Save does (`LeaveLink`, #243), and
 * the status chip that keeps the queue's state in view, and under it the word on the public
 * catalogue after a synced delete ([PUB-16]).
 * It renders on the server and in the static shell alike: it reads nothing but its props, and the
 * chip and the word read only what the device itself keeps, in the browser.
 */
import type { ReactNode } from 'react';
import { LeaveLink, StatusChip, SyncedCatalogueNotice } from '../_offline/client';

export function Header({ title, back }: { readonly title: string; readonly back?: { readonly href: string; readonly label: string } }) {
  return (
    <>
      <header className="header">
        {back === undefined ? null : (
          <LeaveLink className="header__back" href={back.href}>
            {back.label}
          </LeaveLink>
        )}
        <h1 className="header__title">{title}</h1>
        <StatusChip />
      </header>
      <SyncedCatalogueNotice />
    </>
  );
}

/**
 * The page's one column of about 640 px. `wide` is the overview's (`/admin`, #203): small gutters
 * on a phone, and from a tablet's width a wider page whose item list is a grid of cards.
 */
export function Page({ children, wide }: { readonly children: ReactNode; readonly wide?: boolean }) {
  return <main className={wide === true ? 'page page--wide' : 'page'}>{children}</main>;
}
