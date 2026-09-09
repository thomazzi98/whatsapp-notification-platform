-- Two references that could point across a tenant boundary.
--
-- Every other foreign key in this schema is composite on purpose: naming the
-- tenant as well as the row is what makes a cross-tenant reference impossible
-- to write rather than merely wrong. These two were the exceptions —
-- `retry_of_notification_id` referenced `notifications(id)` alone, and
-- `idempotency_key_id` referenced nothing at all — so a row could name another
-- tenant's notification or another tenant's idempotency claim and the database
-- would accept it.
--
-- The delete actions name their column explicitly. A plain ON DELETE SET NULL
-- on a composite key nulls every referencing column, including application_id,
-- which is NOT NULL — so the expiry reaper deleting an idempotency key would
-- have failed on the first row it touched.

-- Existing installations first. `idempotency_key_id` has never been checked by
-- the database, and the expiry reaper deletes claims a notification may still
-- name, so a live installation can hold references to rows that no longer
-- exist. Adding the constraint on top of those would fail the migration. The
-- reference is already meaningless, so it is cleared rather than repaired.
UPDATE "notifications" SET "idempotency_key_id" = NULL
WHERE "idempotency_key_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "idempotency_keys"
    WHERE "idempotency_keys"."id" = "notifications"."idempotency_key_id"
      AND "idempotency_keys"."application_id" = "notifications"."application_id"
  );
--> statement-breakpoint

-- The same for a retry whose original was written before the reference named
-- the tenant, or deleted since.
UPDATE "notifications" SET "retry_of_notification_id" = NULL
WHERE "retry_of_notification_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "notifications" AS "original"
    WHERE "original"."id" = "notifications"."retry_of_notification_id"
      AND "original"."application_id" = "notifications"."application_id"
  );
--> statement-breakpoint

ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_application_id_unique" UNIQUE ("application_id", "id");
--> statement-breakpoint

ALTER TABLE "notifications" DROP CONSTRAINT "notifications_retry_of_fkey";
--> statement-breakpoint

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_retry_of_fkey"
  FOREIGN KEY ("application_id", "retry_of_notification_id")
  REFERENCES "public"."notifications" ("application_id", "id")
  ON DELETE SET NULL ("retry_of_notification_id");
--> statement-breakpoint

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_idempotency_key_fkey"
  FOREIGN KEY ("application_id", "idempotency_key_id")
  REFERENCES "public"."idempotency_keys" ("application_id", "id")
  ON DELETE SET NULL ("idempotency_key_id");
