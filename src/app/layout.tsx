/** The root layout: the admin's document, with nothing in it for search engines, registering the service worker. */
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ServiceWorkerRegistration } from './_offline/client';
import { ICONS } from './_offline/shell';
import { en } from './messages/en';
// The admin's one stylesheet, served from `/_next/static/`, which the worker keeps with the shell.
import './admin.css';

export const metadata: Metadata = {
  title: en.app.name,
  robots: { index: false, follow: false },
  // The manifest link comes from `./manifest.ts`; these make the admin installable on iOS too ([SYNC-5]).
  appleWebApp: { capable: true, title: en.app.name, statusBarStyle: 'default' },
  icons: { apple: ICONS[0].src },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f6f8' },
    { media: '(prefers-color-scheme: dark)', color: '#121418' },
  ],
};

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
