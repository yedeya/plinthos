CREATE TABLE "bricklink_call_day" (
	"id" uuid PRIMARY KEY NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"calls" integer NOT NULL,
	CONSTRAINT "bricklink_call_day_calls_check" CHECK ("bricklink_call_day"."calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE "part_price_quote" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_type" text NOT NULL,
	"item_no" text NOT NULL,
	"color_id" integer NOT NULL,
	"new_or_used" text NOT NULL,
	"average" numeric(20, 3),
	"sample_size" integer NOT NULL,
	"currency" text NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone,
	"attempted_at" timestamp with time zone NOT NULL,
	"last_error" text,
	CONSTRAINT "part_price_quote_item_type_check" CHECK ("part_price_quote"."item_type" in ('PART', 'MINIFIG', 'SET', 'BOOK', 'GEAR', 'CATALOG', 'INSTRUCTION', 'ORIGINAL_BOX')),
	CONSTRAINT "part_price_quote_new_or_used_check" CHECK ("part_price_quote"."new_or_used" in ('N', 'U')),
	CONSTRAINT "part_price_quote_source_check" CHECK ("part_price_quote"."source" in ('bricklink')),
	CONSTRAINT "part_price_quote_color_id_check" CHECK ("part_price_quote"."color_id" >= 0),
	CONSTRAINT "part_price_quote_sample_size_check" CHECK ("part_price_quote"."sample_size" >= 0),
	CONSTRAINT "part_price_quote_average_check" CHECK ("part_price_quote"."average" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_refresh_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"all_prices" boolean NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"step_until" timestamp with time zone,
	"done" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"left" integer DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"stop_requested" boolean DEFAULT false NOT NULL,
	CONSTRAINT "price_refresh_run_scope_check" CHECK ("price_refresh_run"."scope" in ('items', 'parts', 'all')),
	CONSTRAINT "price_refresh_run_state_check" CHECK ("price_refresh_run"."state" in ('running', 'done', 'stopped')),
	CONSTRAINT "price_refresh_run_stop_reason_check" CHECK ("price_refresh_run"."stop_reason" in ('owner', 'refused-key', 'rate-limited', 'unreachable', 'daily-limit', 'stalled', 'invoke-failed')),
	CONSTRAINT "price_refresh_run_counts_check" CHECK ("price_refresh_run"."done" >= 0 and "price_refresh_run"."failed" >= 0 and "price_refresh_run"."left" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bricklink_call_day_day_idx" ON "bricklink_call_day" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "part_price_quote_item_idx" ON "part_price_quote" USING btree ("item_type","item_no","color_id","new_or_used");--> statement-breakpoint
CREATE UNIQUE INDEX "price_refresh_run_one_running_idx" ON "price_refresh_run" USING btree ("state") WHERE "price_refresh_run"."state" = 'running';