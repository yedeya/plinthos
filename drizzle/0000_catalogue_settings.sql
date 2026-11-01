CREATE TABLE "catalogue_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_token" text,
	"show_values" boolean DEFAULT false NOT NULL,
	"selling_mode" boolean DEFAULT false NOT NULL,
	"selling_value_display" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalogue_settings_singleton" ON "catalogue_settings" USING btree ((true));