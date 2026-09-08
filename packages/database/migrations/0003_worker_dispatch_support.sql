DROP INDEX "notification_send_attempts_unresolved_index";--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "unknown_outcome_policy" text DEFAULT 'RETRY' NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_send_attempts_unresolved_index" ON "notification_send_attempts" USING btree ("notification_id") WHERE "notification_send_attempts"."outcome" is null;--> statement-breakpoint
ALTER TABLE "notification_send_attempts" DROP COLUMN "claim_token";--> statement-breakpoint
ALTER TABLE "notification_send_attempts" DROP COLUMN "whatsapp_session_id";--> statement-breakpoint
ALTER TABLE "notification_send_attempts" DROP COLUMN "recipient_chat_identifier";--> statement-breakpoint
ALTER TABLE "notification_send_attempts" DROP COLUMN "body_fingerprint";--> statement-breakpoint
ALTER TABLE "notification_send_attempts" DROP COLUMN "provider_status_code";--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_unknown_outcome_policy_check" CHECK ("applications"."unknown_outcome_policy" in ('RETRY', 'FAIL_CLOSED'));--> statement-breakpoint
ALTER TABLE "notification_send_attempts" ADD CONSTRAINT "notification_send_attempts_resolution_check" CHECK (("notification_send_attempts"."outcome" is null) = ("notification_send_attempts"."request_finished_at" is null));