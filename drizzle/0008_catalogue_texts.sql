ALTER TABLE "catalogue_settings" ADD COLUMN "intro_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD COLUMN "contact_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD CONSTRAINT "catalogue_settings_intro_text_check" CHECK (char_length("catalogue_settings"."intro_text") <= 2000);--> statement-breakpoint
ALTER TABLE "catalogue_settings" ADD CONSTRAINT "catalogue_settings_contact_text_check" CHECK (char_length("catalogue_settings"."contact_text") <= 2000);