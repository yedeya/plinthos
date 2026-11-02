CREATE TABLE "parts_import" (
	"id" uuid PRIMARY KEY NOT NULL,
	"file_format" text NOT NULL,
	"currency" text,
	"imported_at" timestamp with time zone NOT NULL,
	"lots" integer NOT NULL,
	"quantity" integer NOT NULL,
	"total_value" numeric(20, 3),
	CONSTRAINT "parts_import_file_format_check" CHECK ("parts_import"."file_format" in ('BSX', 'BL_XML')),
	CONSTRAINT "parts_import_lots_check" CHECK ("parts_import"."lots" >= 1),
	CONSTRAINT "parts_import_quantity_check" CHECK ("parts_import"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "parts_lot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"item_no" text NOT NULL,
	"color_id" integer NOT NULL,
	"lot_condition" text NOT NULL,
	"lot_quantity" integer NOT NULL,
	"unit_price" numeric(12, 3),
	CONSTRAINT "parts_lot_condition_check" CHECK ("parts_lot"."lot_condition" in ('N', 'U')),
	CONSTRAINT "parts_lot_quantity_check" CHECK ("parts_lot"."lot_quantity" >= 1)
);
--> statement-breakpoint
ALTER TABLE "photo" ADD COLUMN "parts_lot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "parts_lot" ADD CONSTRAINT "parts_lot_import_id_parts_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."parts_import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parts_lot_import_id_idx" ON "parts_lot" USING btree ("import_id");--> statement-breakpoint
ALTER TABLE "photo" ADD CONSTRAINT "photo_item_or_parts_lot_check" CHECK (not ("photo"."parts_lot" and "photo"."item_id" is not null));