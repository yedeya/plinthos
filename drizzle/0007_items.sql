CREATE TABLE "collection_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"set_num" text NOT NULL,
	"condition" text NOT NULL,
	"complete" boolean NOT NULL,
	"missing_notes" text,
	"has_instructions" boolean NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"storage_location" text NOT NULL,
	"cover_photo_id" uuid,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "collection_item_condition_check" CHECK ("collection_item"."condition" in ('SEALED', 'USED_WITH_BOX', 'USED_NO_BOX')),
	CONSTRAINT "collection_item_quantity_check" CHECK ("collection_item"."quantity" between 1 and 999),
	CONSTRAINT "collection_item_description_check" CHECK (char_length("collection_item"."description") <= 2000),
	CONSTRAINT "collection_item_storage_location_check" CHECK (char_length("collection_item"."storage_location") <= 200),
	CONSTRAINT "collection_item_missing_notes_check" CHECK (char_length("collection_item"."missing_notes") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "lego_set" (
	"id" uuid PRIMARY KEY NOT NULL,
	"set_num" text NOT NULL,
	"name" text NOT NULL,
	"theme" text NOT NULL,
	"year" integer NOT NULL,
	"num_parts" integer NOT NULL,
	"image_url" text,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lego_set_set_num_unique" UNIQUE("set_num")
);
--> statement-breakpoint
ALTER TABLE "photo" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "photo" ADD COLUMN "position" integer;--> statement-breakpoint
ALTER TABLE "collection_item" ADD CONSTRAINT "collection_item_set_num_lego_set_set_num_fk" FOREIGN KEY ("set_num") REFERENCES "public"."lego_set"("set_num") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_item" ADD CONSTRAINT "collection_item_cover_photo_id_photo_id_fk" FOREIGN KEY ("cover_photo_id") REFERENCES "public"."photo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo" ADD CONSTRAINT "photo_item_id_collection_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."collection_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_item_id_idx" ON "photo" USING btree ("item_id");