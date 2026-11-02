CREATE TABLE "photo" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_key" text NOT NULL,
	"thumbnail_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "photo_full_key_unique" UNIQUE("full_key"),
	CONSTRAINT "photo_thumbnail_key_unique" UNIQUE("thumbnail_key")
);
