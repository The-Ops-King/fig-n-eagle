-- Hot Swap schema. Safe to run repeatedly.

-- Who is on call for which hour. One row per person per hour.
CREATE TABLE IF NOT EXISTS roster_slots (
  id              BIGSERIAL PRIMARY KEY,
  client          TEXT        NOT NULL,
  day             DATE        NOT NULL,          -- local date in the client's timezone
  hour            SMALLINT    NOT NULL,          -- local hour 0-23
  ghl_user_id     TEXT        NOT NULL,
  block_event_id  TEXT,                          -- GHL blocked-slot id, NULL if blocking failed
  source          TEXT        NOT NULL DEFAULT 'auto',   -- auto | volunteer | replacement
  status          TEXT        NOT NULL DEFAULT 'active', -- active | released
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS roster_slots_active_uniq
  ON roster_slots (client, day, hour, ghl_user_id) WHERE status = 'active';

-- The posted roster message for a day, so it can be edited after swaps.
CREATE TABLE IF NOT EXISTS roster_posts (
  client      TEXT NOT NULL,
  day         DATE NOT NULL,
  channel     TEXT NOT NULL,
  ts          TEXT NOT NULL,
  PRIMARY KEY (client, day)
);

-- Every hot-swap request and what happened to it. This is the SLA log.
CREATE TABLE IF NOT EXISTS swap_requests (
  id                   BIGSERIAL PRIMARY KEY,
  client               TEXT        NOT NULL,
  appointment_id       TEXT        NOT NULL,
  calendar_id          TEXT,
  contact_id           TEXT,
  contact_name         TEXT,
  appt_start           TIMESTAMPTZ NOT NULL,
  from_ghl_user_id     TEXT,
  from_slack_user_id   TEXT        NOT NULL,
  reason               TEXT,
  channel              TEXT,
  ts                   TEXT,
  escalation_msg_id    TEXT,
  status               TEXT        NOT NULL DEFAULT 'open',   -- open | claimed | cancelled
  requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at           TIMESTAMPTZ,
  claimed_by_ghl       TEXT,
  claimed_by_slack     TEXT,
  reassign_error       TEXT
);
-- One open request per appointment.
CREATE UNIQUE INDEX IF NOT EXISTS swap_requests_open_uniq
  ON swap_requests (client, appointment_id) WHERE status = 'open';

-- Manager changes to the pool made from Slack (/hotswap add|remove).
CREATE TABLE IF NOT EXISTS pool_overrides (
  client       TEXT        NOT NULL,
  ghl_user_id  TEXT        NOT NULL,
  action       TEXT        NOT NULL,   -- add | remove
  name         TEXT,
  email        TEXT,
  slack_user_id TEXT,
  changed_by   TEXT,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client, ghl_user_id)
);
