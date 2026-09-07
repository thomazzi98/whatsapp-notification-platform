#!/bin/sh
# Creates the least-privileged role the application uses at runtime.
#
# Two roles exist so row level security means something: the system role owns
# the schema and bypasses policies, while the application role is subject to
# them. Running the application as the owner would silently disable every
# policy, because a table owner is exempt by default.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APPLICATION_DATABASE_USER}') THEN
    CREATE ROLE ${APPLICATION_DATABASE_USER} LOGIN PASSWORD '${APPLICATION_DATABASE_PASSWORD}';
  END IF;
END
\$\$;

GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APPLICATION_DATABASE_USER};
GRANT USAGE ON SCHEMA public TO ${APPLICATION_DATABASE_USER};

-- Applies to tables the system role creates from here on, which is how
-- migrations grant access without a follow-up step.
ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APPLICATION_DATABASE_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${APPLICATION_DATABASE_USER};

-- A runaway query must not hold resources indefinitely.
ALTER ROLE ${APPLICATION_DATABASE_USER} SET statement_timeout = '5s';
ALTER ROLE ${APPLICATION_DATABASE_USER} SET idle_in_transaction_session_timeout = '10s';
SQL
