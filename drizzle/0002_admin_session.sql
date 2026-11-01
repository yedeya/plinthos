CREATE TABLE "admin_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"id_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_session_id_hash_unique" UNIQUE("id_hash")
);
