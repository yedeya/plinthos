'use client';

/** The App Router's error page below the root layout ([OPS-5], `failed-request.tsx`). */
import { FailedRequest } from './failed-request';

export default function ErrorPage({ error }: { readonly error: Error & { digest?: string }; readonly reset: () => void }) {
  return <FailedRequest digest={error.digest} />;
}
