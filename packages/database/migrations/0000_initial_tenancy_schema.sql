CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_identifier" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"last_four" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_last_four_check" CHECK (length("api_keys"."last_four") = 4),
	CONSTRAINT "api_keys_scopes_not_empty_check" CHECK (cardinality("api_keys"."scopes") >= 1)
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 60 NOT NULL,
	"rate_limit_burst" integer DEFAULT 10 NOT NULL,
	"daily_send_limit" integer,
	"default_maximum_attempts" integer DEFAULT 5 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_status_check" CHECK ("applications"."status" in ('ACTIVE', 'SUSPENDED')),
	CONSTRAINT "applications_rate_limit_per_minute_check" CHECK ("applications"."rate_limit_per_minute" between 1 and 6000),
	CONSTRAINT "applications_rate_limit_burst_check" CHECK ("applications"."rate_limit_burst" between 1 and 1000),
	CONSTRAINT "applications_daily_send_limit_check" CHECK ("applications"."daily_send_limit" is null or "applications"."daily_send_limit" > 0),
	CONSTRAINT "applications_default_maximum_attempts_check" CHECK ("applications"."default_maximum_attempts" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'MEMBER' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('OWNER', 'ADMIN', 'MEMBER')),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('ACTIVE', 'DISABLED')),
	CONSTRAINT "users_failed_login_count_check" CHECK ("users"."failed_login_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_identifier_unique" ON "api_keys" USING btree ("key_identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_unique" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_active_by_application_index" ON "api_keys" USING btree ("application_id") WHERE "api_keys"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "applications_organization_slug_unique" ON "applications" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "applications_organization_id_index" ON "applications" USING btree ("organization_id") WHERE "applications"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_hash_unique" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_sessions_active_by_user_index" ON "user_sessions" USING btree ("user_id") WHERE "user_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "user_sessions_idle_expires_at_index" ON "user_sessions" USING btree ("idle_expires_at") WHERE "user_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_organization_id_index" ON "users" USING btree ("organization_id");