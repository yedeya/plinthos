import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { check, index, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The owner's loose parts (#161, [PARTS-3]): the last import of a BrickStore or BrickLink file,
 * and its lots. `importPartsFile` (`src/server/parts/`) replaces both in one transaction, so there
 * is at most one `parts_import` row, and every lot belongs to it.
 *
 * Nothing here holds the file, a remark, a comment or any field but the six the parser keeps
 * ([PARTS-1], [PARTS-2]). Unit prices and the total value are private ([PARTS-4]).
 */

export const PARTS_FORMATS = ['BSX', 'BL_XML'] as const;
export const PARTS_CONDITIONS = ['N', 'U'] as const;

export const partsImport = pgTable(
  'parts_import',
  {
    // The application makes every key, never the database ([PLAT-13]).
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    // Named apart from any public column's name, so the publish step's key check can tell them apart ([PUB-4]).
    fileFormat: text('file_format', { enum: PARTS_FORMATS }).notNull(),
    /** The file's currency code, when it named one; the unit prices and the total value are in it. */
    currency: text('currency'),
    importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' }).notNull(),
    lots: integer('lots').notNull(),
    quantity: integer('quantity').notNull(),
    /** The sum of unit price × quantity over the lots with a price; null when no lot had one. */
    totalValue: numeric('total_value', { precision: 20, scale: 3, mode: 'number' }),
  },
  (table) => [
    check('parts_import_file_format_check', sql`${table.fileFormat} in ('BSX', 'BL_XML')`),
    check('parts_import_lots_check', sql`${table.lots} >= 1`),
    check('parts_import_quantity_check', sql`${table.quantity} >= 1`),
  ],
);

export const partsLot = pgTable(
  'parts_lot',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    importId: uuid('import_id')
      .notNull()
      .references(() => partsImport.id),
    /** BrickLink's item type, one letter: `P` for a part, `M` for a minifigure (the parser holds it to one). */
    itemType: text('item_type').notNull(),
    itemNo: text('item_no').notNull(),
    colorId: integer('color_id').notNull(),
    // `lot_` keeps them apart from `collection_item`'s public condition and quantity ([PUB-4]).
    lotCondition: text('lot_condition', { enum: PARTS_CONDITIONS }).notNull(),
    lotQuantity: integer('lot_quantity').notNull(),
    /** The file's unit price, in its currency; null when the file had none for the lot. */
    unitPrice: numeric('unit_price', { precision: 12, scale: 3, mode: 'number' }),
  },
  (table) => [
    index('parts_lot_import_id_idx').on(table.importId),
    check('parts_lot_condition_check', sql`${table.lotCondition} in ('N', 'U')`),
    check('parts_lot_quantity_check', sql`${table.lotQuantity} >= 1`),
  ],
);
