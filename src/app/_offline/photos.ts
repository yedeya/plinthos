/**
 * The phone's half of the photo path (#22, brief #6, decision 18).
 *
 * - `preparePhoto` resizes a picked photo to the configured longest edge and re-compresses it as
 *   JPEG, upright, before anything is queued ([PHOTO-1]). Drawing it on a canvas is what turns
 *   it upright and leaves its metadata behind on the phone too, though the server re-encodes it
 *   regardless ([PHOTO-3]).
 * - `queuePhoto` puts the JPEG's bytes and its SHA-256 in the queue as a `registerPhoto`, with no
 *   quarantine key yet.
 * - `uploadPhoto` runs at replay: it asks the presign route for an upload into the quarantine
 *   and posts the bytes straight to S3, never through the admin's server function.
 *
 * The bytes stay in the queue until the server answers the `registerPhoto` as applied or already
 * applied (#9): the replay uploads them again when the server says the upload is gone.
 */
import type { OfflineQueue, QueuedEntry } from './queue';

/** The presign route (`src/app/admin/api/photos/uploads/route.ts`). */
export const PRESIGN_ENDPOINT = '/admin/api/photos/uploads';

/** The longest edge when the device has not been told the deployment's yet: `DEFAULT_LONGEST_EDGE` on the server. */
export const DEFAULT_LONGEST_EDGE = 2048;

/** Where the device keeps the longest edge `/admin` last told it, for the offline shell. */
export const LONGEST_EDGE_STORAGE_KEY = 'plinthos.photo.longestEdge';

/** The JPEG quality the phone re-compresses with. */
export const JPEG_QUALITY = 0.85;

/** How long a presign or an upload may take. */
export const UPLOAD_TIMEOUT_MS = 60_000;

/** The SHA-256 of the bytes, as lowercase hex, which `registerPhoto` checks the upload by ([PHOTO-2]). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The size a photo is drawn at: its longest edge at most `longestEdge`, never enlarged. */
export function fitWithin(width: number, height: number, longestEdge: number): { width: number; height: number } {
  const scale = Math.min(1, longestEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Resizes a picked photo and re-compresses it as JPEG, in the browser ([PHOTO-1]). */
export async function preparePhoto(file: Blob, longestEdge: number): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, longestEdge);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('this browser cannot draw the photo');
    context.drawImage(bitmap, 0, 0, width, height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return await jpeg.arrayBuffer();
  } finally {
    bitmap.close();
  }
}

/** Queues a prepared photo as a `registerPhoto`, behind every other change. */
export async function queuePhoto(queue: OfflineQueue, bytes: ArrayBuffer): Promise<QueuedEntry> {
  return queue.enqueue({ name: 'registerPhoto', input: { sha256: await sha256Hex(bytes) }, upload: { bytes } });
}

export type UploadResult =
  | { readonly status: 'uploaded'; readonly quarantineKey: string }
  /** The session ended: sign in first. */
  | { readonly status: 'signed-out' }
  /** The network is gone, or S3 or the route could not be reached: try at the next trigger. */
  | { readonly status: 'offline' }
  /** S3 refused the bytes, such as a photo over the size cap: retrying won't help. */
  | { readonly status: 'refused'; readonly issue: string }
  | { readonly status: 'error' };

interface Presigned {
  readonly key?: unknown;
  readonly url?: unknown;
  readonly fields?: unknown;
  readonly maxBytes?: unknown;
}

/** Uploads one queued photo's bytes into the quarantine, through a fresh presigned upload. */
export async function uploadPhoto(entry: QueuedEntry, options: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {}): Promise<UploadResult> {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  if (entry.upload === undefined) return { status: 'error' };
  const { bytes } = entry.upload;

  let presigned: Presigned;
  try {
    const response = await send(PRESIGN_ENDPOINT, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401) return { status: 'signed-out' };
    if (!response.ok) return { status: 'error' };
    presigned = (await response.json()) as Presigned;
  } catch {
    return { status: 'offline' };
  }
  const { key, url, fields, maxBytes } = presigned;
  if (typeof key !== 'string' || typeof url !== 'string' || typeof fields !== 'object' || fields === null) return { status: 'error' };
  if (typeof maxBytes === 'number' && bytes.byteLength > maxBytes) {
    return { status: 'refused', issue: `the photo is ${bytes.byteLength} bytes, over the cap of ${maxBytes}` };
  }

  // The policy's fields first, the file last, as S3 requires of a POST.
  const form = new FormData();
  for (const [name, value] of Object.entries(fields as Record<string, unknown>)) form.append(name, String(value));
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }));
  try {
    const response = await send(url, { method: 'POST', body: form, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) return { status: 'uploaded', quarantineKey: key };
    // 400 is S3 refusing the form itself, such as a file over the cap: the same bytes would be
    // refused again. Anything else, such as a 403 for a policy that expired while the phone
    // slept, is tried again at the next trigger with a fresh presign.
    if (response.status === 400) return { status: 'refused', issue: 'the photo store refused the upload, most likely as over the size cap' };
    return { status: 'error' };
  } catch {
    return { status: 'offline' };
  }
}
