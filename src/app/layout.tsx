/** The root layout: the admin's document, with nothing in it for search engines, registering the service worker. */
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ServiceWorkerRegistration } from './_offline/client';
import { ICONS } from './_offline/shell';

export const metadata: Metadata = {
  title: 'Plinthos',
  robots: { index: false, follow: false },
  // The manifest link comes from `./manifest.ts`; these make the admin installable on iOS too ([SYNC-5]).
  appleWebApp: { capable: true, title: 'Plinthos', statusBarStyle: 'default' },
  icons: { apple: ICONS[0].src },
};

export const viewport: Viewport = { themeColor: '#b40000' };

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
