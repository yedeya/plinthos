'use client';

/** The App Router's error page when the root layout itself fails, so it renders its own document ([OPS-5]). */
import { FailedRequest } from './failed-request';

export default function GlobalError({ error }: { readonly error: Error & { digest?: string }; readonly reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <FailedRequest digest={error.digest} />
      </body>
    </html>
  );
}
