CREATE TABLE "applied_mutation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" text,
	"applied_at" timestamp with time zone NOT NULL
);
