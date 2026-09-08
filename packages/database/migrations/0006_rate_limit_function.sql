-- Rate limiting by the generic cell rate algorithm.
--
-- A fixed window lets a caller spend a whole allowance at the end of one window
-- and the next allowance at the start of the following one, so a "sixty a
-- minute" limit permits a hundred and twenty in two seconds. A sliding log
-- fixes that by storing every request, which is a row per call on the busiest
-- table in the system.
--
-- GCRA stores one timestamp instead: the moment at which the next request would
-- be exactly on pace. Requests earlier than that are borrowing against the
-- future, and the burst allowance is how far ahead a caller may borrow. It
-- costs one row and one in-place update per request, and it yields an exact
-- Retry-After rather than "try again next window".

CREATE OR REPLACE FUNCTION consume_rate_limit(
  subject_key text,
  requests_per_period integer,
  burst_allowance integer,
  period_seconds integer,
  requested_at timestamptz
)
RETURNS TABLE (
  is_allowed boolean,
  remaining_requests integer,
  retry_after_seconds double precision,
  resets_after_seconds double precision
)
LANGUAGE plpgsql
AS $$
DECLARE
  -- How far apart requests would be if the caller were exactly on pace.
  emission_interval interval;
  -- How far ahead of pace a caller may run before being refused.
  delay_tolerance interval;
  -- Set only when the request was granted.
  granted_arrival timestamptz;
  -- The state before this statement, used to explain a refusal.
  current_arrival timestamptz;
  effective_arrival timestamptz;
BEGIN
  IF requests_per_period <= 0 OR period_seconds <= 0 THEN
    RAISE EXCEPTION 'A rate limit needs a positive allowance and period.';
  END IF;

  emission_interval := make_interval(secs => period_seconds::double precision / requests_per_period);
  delay_tolerance := emission_interval * greatest(burst_allowance, 1);

  -- The decision and the write are one statement, and the write is what takes
  -- the lock. Reading first and writing second would leave a window in which
  -- two callers both observe the same state and both conclude they are within
  -- the limit — and for a subject with no row yet there is nothing to lock at
  -- all, so `SELECT ... FOR UPDATE` would serialise nothing.
  WITH attempt AS (
    INSERT INTO rate_limit_buckets AS bucket (subject, theoretical_arrival_at, updated_at)
    VALUES (subject_key, requested_at + emission_interval, requested_at)
    ON CONFLICT (subject) DO UPDATE
      SET theoretical_arrival_at =
            greatest(bucket.theoretical_arrival_at, requested_at) + emission_interval,
          updated_at = requested_at
      WHERE greatest(bucket.theoretical_arrival_at, requested_at) + emission_interval
              - delay_tolerance <= requested_at
    RETURNING bucket.theoretical_arrival_at
  )
  SELECT
    (SELECT attempt.theoretical_arrival_at FROM attempt),
    -- Reads the row as it was before this statement, which is exactly the
    -- state a refusal needs to explain itself.
    (SELECT existing.theoretical_arrival_at
     FROM rate_limit_buckets existing
     WHERE existing.subject = subject_key)
  INTO granted_arrival, current_arrival;

  IF granted_arrival IS NOT NULL THEN
    RETURN QUERY SELECT
      true,
      -- What could still be spent right now: the distance between where the
      -- caller now is and the far edge of the burst allowance.
      greatest(
        0,
        floor(
          extract(epoch FROM (requested_at + delay_tolerance - granted_arrival))
          / extract(epoch FROM emission_interval)
        )
      )::integer,
      0::double precision,
      greatest(0, extract(epoch FROM (granted_arrival - requested_at)))::double precision;
    RETURN;
  END IF;

  effective_arrival := greatest(coalesce(current_arrival, requested_at), requested_at);

  RETURN QUERY SELECT
    false,
    0,
    -- Exactly how long until one more would be on pace, rather than "until the
    -- next window", which is the answer a fixed window is forced to give.
    greatest(
      0,
      extract(epoch FROM (effective_arrival + emission_interval - delay_tolerance - requested_at))
    )::double precision,
    greatest(0, extract(epoch FROM (effective_arrival - requested_at)))::double precision;
END $$;
--> statement-breakpoint

-- Buckets are worthless once they are older than any window they could belong
-- to: the algorithm treats a missing row and an expired one identically.
CREATE OR REPLACE FUNCTION prune_rate_limit_buckets(older_than timestamptz)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM rate_limit_buckets WHERE updated_at < older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;

  RETURN removed;
END $$;
