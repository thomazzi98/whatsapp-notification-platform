-- What WhatsApp enforces on a connection's account, and the pause it causes.
--
-- While the account is in a reachout timelock every message to a new contact
-- is refused, and refusals repeated through one are what turn it into a ban,
-- so the platform stops sending from the connection until it lifts. Every
-- column is nullable: a row from before this migration has no pause and
-- nothing known yet about its limits, which is exactly what null says.
ALTER TABLE "whatsapp_sessions" ADD COLUMN "sending_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_sessions" ADD COLUMN "sending_paused_reason" text;--> statement-breakpoint
ALTER TABLE "whatsapp_sessions" ADD COLUMN "account_limits" jsonb;--> statement-breakpoint
ALTER TABLE "whatsapp_sessions" ADD COLUMN "account_limits_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_sessions" ADD CONSTRAINT "whatsapp_sessions_sending_paused_reason_check" CHECK ("whatsapp_sessions"."sending_paused_reason" in ('REACHOUT_TIMELOCK'));--> statement-breakpoint
ALTER TABLE "whatsapp_sessions" ADD CONSTRAINT "whatsapp_sessions_sending_pause_pair_check" CHECK (("whatsapp_sessions"."sending_paused_until" is null) = ("whatsapp_sessions"."sending_paused_reason" is null));
