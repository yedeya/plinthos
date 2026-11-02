import { randomUUID } from 'node:crypto';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The owner's stored photos, one row each (#22, `src/server/photos/`). In the walking skeleton a
 * photo belongs to no set and is never published: set entry links photos to items, and the
 * public catalogue milestone publishes them.
 *
 * A row is written only after both re-encoded sizes are in the private photo bucket, in the same
 * transaction as the applied-mutation record of the `registerPhoto` that made it ([PHOTO-3]), so a
 * row always has its files. The keys are random and made by the server ([PHOTO-6]); nothing here
 * holds the client's id, the quarantine key or the uploaded bytes.
 */
export const photo = pgTable('photo', {
  // The application makes every key, never the database ([PLAT-13]).
  id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
  fullKey: text('full_key').notNull().unique(),
  thumbnailKey: text('thumbnail_key').notNull().unique(),
  /** The SHA-256 of the bytes the phone uploaded, as hex: what `registerPhoto` checked them by. */
  sha256: text('sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
});
