ALTER TABLE "collection_item" ALTER COLUMN "set_num" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_item" ALTER COLUMN "complete" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_item" ALTER COLUMN "has_instructions" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_item" ADD COLUMN "kind" text DEFAULT 'SET' NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_item" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "collection_item" ADD COLUMN "ref_no" text;--> statement-breakpoint
ALTER TABLE "collection_item" ADD COLUMN "approx_parts" integer;--> statement-breakpoint
ALTER TABLE "collection_item" ADD COLUMN "approx_weight_g" integer;--> statement-breakpoint
ALTER TABLE "collection_item" ADD CONSTRAINT "collection_item_kind_check" CHECK ("collection_item"."kind" in ('SET', 'MINIFIG', 'BULK', 'OTHER'));--> statement-breakpoint
ALTER TABLE "collection_item" ADD CONSTRAINT "collection_item_kind_identity_check" CHECK (("collection_item"."kind" = 'SET' and "collection_item"."set_num" is not null) or ("collection_item"."kind" <> 'SET' and "collection_item"."name" is not null));--> statement-breakpoint
ALTER TABLE "collection_item" ADD CONSTRAINT "collection_item_name_check" CHECK (char_length("collection_item"."name") between 1 and 200);--> statement-breakpoint
ALTER TABLE "collection_item" ADD CONSTRAINT "collection_item_ref_no_check" CHECK (char_length("collection_item"."ref_no") between 1 and 40);--> statement-breakpoint
ALTER TABLE "collection_item" ADD CONSTRAINT "collection_item_approx_parts_check" CHECK ("collection_item"."approx_parts" between 1 and 1000000);--> statement-breakpoint
ALTER TABLE "collection_item" ADD CONSTRAINT "collection_item_approx_weight_g_check" CHECK ("collection_item"."approx_weight_g" between 1 and 10000000);