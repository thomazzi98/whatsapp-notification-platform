CREATE TABLE "rate_limit_buckets" (
	"subject" text PRIMARY KEY NOT NULL,
	"theoretical_arrival_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_buckets_subject_length_check" CHECK (length("rate_limit_buckets"."subject") between 1 and 200)
);
