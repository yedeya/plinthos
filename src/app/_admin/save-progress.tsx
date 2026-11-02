'use client';
/**
 * What a Save shows while it waits for its own sync (#168, #203): a progress bar and "Uploading
 * photos 3 of 8" while the sync's upload loop reports progress (`QUEUE_PROGRESS`), then "Saving…"
 * while the server stores the batch, or at once when there are no photos to upload. It reads only
 * the events this tab's sync sends, never the server. It listens while the form is open, so the
 * first event, which may come before Save starts waiting, isn't missed; it shows only when `active`.
 */
import { useUploadProgress } from '../_offline/client';
import { en } from '../messages/en';

export function SaveProgress({ active }: { readonly active: boolean }) {
  const progress = useUploadProgress();
  if (!active) return null;
  const m = en.form;
  const uploading = progress !== null && progress.uploaded < progress.total;
  return (
    <div className="save-progress" role="status" aria-label={m.saveProgressLabel}>
      {/* Without a value the bar is indeterminate: the server is storing what was sent. */}
      {uploading ? <progress className="progress" max={progress.total} value={progress.uploaded} /> : <progress className="progress" />}
      <span>{uploading ? m.uploadingPhotos(progress.uploaded, progress.total) : m.saving}</span>
    </div>
  );
}
