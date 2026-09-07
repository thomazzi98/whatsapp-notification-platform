CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_method" text NOT NULL,
	"request_path" text NOT NULL,
	"request_fingerprint" "bytea" NOT NULL,
	"state" text NOT NULL,
	"lock_token" uuid NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"resource_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_state_check" CHECK ("idempotency_keys"."state" in ('IN_FLIGHT', 'COMPLETED')),
	CONSTRAINT "idempotency_keys_key_length_check" CHECK (length("idempotency_keys"."key") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"attempt_number" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_send_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"claim_token" uuid NOT NULL,
	"whatsapp_session_id" uuid NOT NULL,
	"recipient_chat_identifier" text NOT NULL,
	"body_fingerprint" text NOT NULL,
	"request_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_finished_at" timestamp with time zone,
	"outcome" text,
	"provider_message_id" text,
	"provider_status_code" integer,
	"failure_code" text,
	CONSTRAINT "notification_send_attempts_attempt_number_check" CHECK ("notification_send_attempts"."attempt_number" >= 1),
	CONSTRAINT "notification_send_attempts_outcome_check" CHECK ("notification_send_attempts"."outcome" is null or "notification_send_attempts"."outcome" in ('SUCCEEDED', 'FAILED', 'UNKNOWN'))
);
--> statement-breakpoint
CREATE TABLE "notification_statuses" (
	"status" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_status_transitions" (
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	CONSTRAINT "notification_status_transitions_from_status_to_status_pk" PRIMARY KEY("from_status","to_status")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"whatsapp_session_id" uuid NOT NULL,
	"template_id" uuid,
	"status" text NOT NULL,
	"recipient_phone_number" text NOT NULL,
	"recipient_chat_identifier" text,
	"rendered_body" text NOT NULL,
	"template_variables" jsonb,
	"priority" smallint DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"maximum_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"provider_message_id" text,
	"provider_acknowledgement" smallint DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"failure_code" text,
	"failure_reason" text,
	"failure_classification" text,
	"retry_of_notification_id" uuid,
	"idempotency_key_id" uuid,
	"correlation_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_application_id_unique" UNIQUE("application_id","id"),
	CONSTRAINT "notifications_scheduled_requires_time_check" CHECK ("notifications"."status" <> 'SCHEDULED' or "notifications"."scheduled_at" is not null),
	CONSTRAINT "notifications_retrying_requires_next_attempt_check" CHECK ("notifications"."status" <> 'RETRYING' or "notifications"."next_attempt_at" is not null),
	CONSTRAINT "notifications_sent_requires_message_id_check" CHECK ("notifications"."status" not in ('SENT', 'DELIVERED') or "notifications"."provider_message_id" is not null),
	CONSTRAINT "notifications_attempt_count_check" CHECK ("notifications"."attempt_count" >= 0),
	CONSTRAINT "notifications_maximum_attempts_check" CHECK ("notifications"."maximum_attempts" between 1 and 10),
	CONSTRAINT "notifications_acknowledgement_check" CHECK ("notifications"."provider_acknowledgement" between -1 and 4),
	CONSTRAINT "notifications_body_length_check" CHECK (length("notifications"."rendered_body") between 1 and 4096),
	CONSTRAINT "notifications_failure_classification_check" CHECK ("notifications"."failure_classification" is null or "notifications"."failure_classification" in ('RETRYABLE', 'PERMANENT'))
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_application_id_unique" UNIQUE("application_id","id"),
	CONSTRAINT "templates_key_check" CHECK ("templates"."key" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "templates_version_check" CHECK ("templates"."version" >= 1),
	CONSTRAINT "templates_body_length_check" CHECK (length("templates"."body") between 1 and 4096),
	CONSTRAINT "templates_status_check" CHECK ("templates"."status" in ('DRAFT', 'ACTIVE', 'ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"provider" text DEFAULT 'WAHA' NOT NULL,
	"provider_session_name" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'STOPPED' NOT NULL,
	"phone_number" text,
	"push_name" text,
	"webhook_signing_key_ciphertext" "bytea" NOT NULL,
	"webhook_signing_key_version" smallint DEFAULT 1 NOT NULL,
	"send_pacing_minimum_seconds" integer DEFAULT 30 NOT NULL,
	"send_pacing_maximum_seconds" integer DEFAULT 60 NOT NULL,
	"next_send_allowed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_status_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_sessions_application_id_unique" UNIQUE("application_id","id"),
	CONSTRAINT "whatsapp_sessions_status_check" CHECK ("whatsapp_sessions"."status" in ('STOPPED', 'STARTING', 'SCAN_QR_CODE', 'WORKING', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "whatsapp_sessions_pacing_range_check" CHECK ("whatsapp_sessions"."send_pacing_maximum_seconds" >= "whatsapp_sessions"."send_pacing_minimum_seconds"),
	CONSTRAINT "whatsapp_sessions_pacing_minimum_check" CHECK ("whatsapp_sessions"."send_pacing_minimum_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_notification_fkey" FOREIGN KEY ("application_id","notification_id") REFERENCES "public"."notifications"("application_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_send_attempts" ADD CONSTRAINT "notification_send_attempts_notification_fkey" FOREIGN KEY ("application_id","notification_id") REFERENCES "public"."notifications"("application_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_status_transitions" ADD CONSTRAINT "notification_status_transitions_from_status_notification_statuses_status_fk" FOREIGN KEY ("from_status") REFERENCES "public"."notification_statuses"("status") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_status_transitions" ADD CONSTRAINT "notification_status_transitions_to_status_notification_statuses_status_fk" FOREIGN KEY ("to_status") REFERENCES "public"."notification_statuses"("status") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_status_notification_statuses_status_fk" FOREIGN KEY ("status") REFERENCES "public"."notification_statuses"("status") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_session_fkey" FOREIGN KEY ("application_id","whatsapp_session_id") REFERENCES "public"."whatsapp_sessions"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_template_fkey" FOREIGN KEY ("application_id","template_id") REFERENCES "public"."templates"("application_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_retry_of_fkey" FOREIGN KEY ("retry_of_notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_sessions" ADD CONSTRAINT "whatsapp_sessions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_application_key_unique" ON "idempotency_keys" USING btree ("application_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_index" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_stale_in_flight_index" ON "idempotency_keys" USING btree ("created_at") WHERE "idempotency_keys"."state" = 'IN_FLIGHT';--> statement-breakpoint
CREATE INDEX "notification_events_timeline_index" ON "notification_events" USING btree ("notification_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "notification_events_activity_feed_index" ON "notification_events" USING btree ("application_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_send_attempts_unique" ON "notification_send_attempts" USING btree ("notification_id","attempt_number");--> statement-breakpoint
CREATE INDEX "notification_send_attempts_unresolved_index" ON "notification_send_attempts" USING btree ("request_started_at") WHERE "notification_send_attempts"."outcome" is null;--> statement-breakpoint
CREATE INDEX "notifications_application_created_at_index" ON "notifications" USING btree ("application_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notifications_application_status_created_at_index" ON "notifications" USING btree ("application_id","status","created_at");--> statement-breakpoint
CREATE INDEX "notifications_application_recipient_index" ON "notifications" USING btree ("application_id","recipient_phone_number","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_provider_message_id_unique" ON "notifications" USING btree ("whatsapp_session_id","provider_message_id") WHERE "notifications"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "notifications_due_scheduled_index" ON "notifications" USING btree ("scheduled_at") WHERE "notifications"."status" = 'SCHEDULED';--> statement-breakpoint
CREATE INDEX "notifications_due_retry_index" ON "notifications" USING btree ("next_attempt_at") WHERE "notifications"."status" = 'RETRYING';--> statement-breakpoint
CREATE INDEX "notifications_stuck_claims_index" ON "notifications" USING btree ("claimed_at") WHERE "notifications"."status" = 'PROCESSING';--> statement-breakpoint
CREATE INDEX "notifications_template_usage_index" ON "notifications" USING btree ("template_id") WHERE "notifications"."template_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "templates_application_key_version_unique" ON "templates" USING btree ("application_id","key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_active_version_unique" ON "templates" USING btree ("application_id","key") WHERE "templates"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "templates_application_updated_at_index" ON "templates" USING btree ("application_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_sessions_provider_name_unique" ON "whatsapp_sessions" USING btree ("provider","provider_session_name");--> statement-breakpoint
CREATE INDEX "whatsapp_sessions_application_status_index" ON "whatsapp_sessions" USING btree ("application_id","status");