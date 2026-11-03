import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { collectionItem } from "./collection-item";

/**
 * The owner's stored photos, one row each (#22, `src/server/photos/`). A photo belongs to at most
 * one item, at a position among that item's photos (#124, [ITEM-6]), or to the parts lot, at a
 * position among its overview photos (#161, [PARTS-5]), never both; one that belongs to none,
 * as every walking-skeleton photo does, has neither. No photo is published yet: the public
 * catalogue milestone publishes them.
 *
 * A row is written only after both re-encoded sizes are in the private photo bucket, in the same
 * transaction as the applied-mutation record of the `registerPhoto` that made it ([PHOTO-3]), so a
 * row always has its files. The keys are random and made by the server ([PHOTO-6]); nothing here
 * holds the client's id, the quarantine key or the uploaded bytes.
 */
export const photo = pgTable(
  "photo",
  {
    // The application makes every key, never the database ([PLAT-13]).
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    fullKey: text("full_key").notNull().unique(),
    thumbnailKey: text("thumbnail_key").notNull().unique(),
    /** The SHA-256 of the bytes the phone uploaded, as hex: what `registerPhoto` checked them by. */
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /**
     * The item the photo belongs to. Deleting an item deletes its photos in code, so their stored
     * files move to the trash too ([ITEM-5], [PHOTO-9]): the key refuses a delete that would leave
     * one behind.
     */
    itemId: uuid("item_id").references((): AnyPgColumn => collectionItem.id),
    /** Its place among the item's photos, or among the parts lot's, from 0; null when it belongs to neither. */
    position: integer("position"),
    /**
     * Whether the photo is one of the parts lot's overview photos ([PARTS-5]). A photo belongs
     * to an item or to the parts lot, never both. The database default keeps the code deployed
     * before it working (`docs/qa/stack.md`, `## Schema changes`).
     */
    partsLot: boolean("parts_lot").notNull().default(false),
  },
  (table) => [
    index("photo_item_id_idx").on(table.itemId),
    check("photo_item_or_parts_lot_check", sql`not (${table.partsLot} and ${table.itemId} is not null)`),
  ],
);
