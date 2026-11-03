ALTER TABLE "catalogue_settings" ADD COLUMN "asking_price_total" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD COLUMN "asking_price_sealed" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD COLUMN "asking_price_used" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD COLUMN "asking_price_parts" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD CONSTRAINT "catalogue_settings_selling_value_display_check" CHECK ("catalogue_settings"."selling_value_display" in ('ASKING', 'MARKET', 'BOTH'));--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD CONSTRAINT "catalogue_settings_asking_price_total_check" CHECK ("catalogue_settings"."asking_price_total" between 0 and 1000000000);--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD CONSTRAINT "catalogue_settings_asking_price_sealed_check" CHECK ("catalogue_settings"."asking_price_sealed" between 0 and 1000000000);--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD CONSTRAINT "catalogue_settings_asking_price_used_check" CHECK ("catalogue_settings"."asking_price_used" between 0 and 1000000000);--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD CONSTRAINT "catalogue_settings_asking_price_parts_check" CHECK ("catalogue_settings"."asking_price_parts" between 0 and 1000000000);