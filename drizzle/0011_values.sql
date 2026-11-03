CREATE TABLE "price_quote" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_type" text NOT NULL,
	"item_no" text NOT NULL,
	"new_or_used" text NOT NULL,
	"average" numeric(20, 3),
	"sample_size" integer NOT NULL,
	"currency" text NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone,
	"attempted_at" timestamp with time zone NOT NULL,
	"last_error" text,
	CONSTRAINT "price_quote_item_type_check" CHECK ("price_quote"."item_type" in ('SET', 'MINIFIG')),
	CONSTRAINT "price_quote_new_or_used_check" CHECK ("price_quote"."new_or_used" in ('N', 'U')),
	CONSTRAINT "price_quote_source_check" CHECK ("price_quote"."source" in ('bricklink')),
	CONSTRAINT "price_quote_sample_size_check" CHECK ("price_quote"."sample_size" >= 0),
	CONSTRAINT "price_quote_average_check" CHECK ("price_quote"."average" >= 0)
);
--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD COLUMN "adjust_used_with_box_pct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD COLUMN "adjust_used_no_box_pct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_item" ADD COLUMN "manual_value_override" numeric(20, 3);--> statement-breakpoint
ALTER TABLE "collection_item" ADD COLUMN "manual_value_currency" text;--> statement-breakpoint
CREATE UNIQUE INDEX "price_quote_item_idx" ON "price_quote" USING btree ("item_type","item_no","new_or_used");--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD CONSTRAINT "catalogue_settings_adjust_used_with_box_pct_check" CHECK ("catalogue_settings"."adjust_used_with_box_pct" between -100 and 100);--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD CONSTRAINT "catalogue_settings_adjust_used_no_box_pct_check" CHECK ("catalogue_settings"."adjust_used_no_box_pct" between -100 and 100);--> statement-breakpoint
ALTER TABLE "collection_item" ADD CONSTRAINT "collection_item_manual_value_override_check" CHECK ("collection_item"."manual_value_override" >= 0);