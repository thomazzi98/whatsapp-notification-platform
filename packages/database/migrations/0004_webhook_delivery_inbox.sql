CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"whatsapp_session_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_session_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_attempts" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"outcome_detail" text,
	CONSTRAINT "webhook_deliveries_outcome_check" CHECK ("webhook_deliveries"."outcome" is null or "webhook_deliveries"."outcome" in ('APPLIED', 'IGNORED', 'UNMATCHED')),
	CONSTRAINT "webhook_deliveries_resolution_check" CHECK (("webhook_deliveries"."outcome" is null) = ("webhook_deliveries"."processed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_session_fkey" FOREIGN KEY ("application_id","whatsapp_session_id") REFERENCES "public"."whatsapp_sessions"("application_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_provider_event_unique" ON "webhook_deliveries" USING btree ("whatsapp_session_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_unprocessed_index" ON "webhook_deliveries" USING btree ("received_at") WHERE "webhook_deliveries"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_application_received_index" ON "webhook_deliveries" USING btree ("application_id","received_at");