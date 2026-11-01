ALTER TABLE "catalogue_settings" ADD COLUMN "publish_lease" uuid;--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD COLUMN "publish_lease_until" timestamp with time zone;