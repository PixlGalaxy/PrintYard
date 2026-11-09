-- SliceDock Phase 4: notifications (status/notify-notes.md).

-- Web Push subscriptions, one per browser/device. Deleted when the push service answers 404/410.
CREATE TABLE push_subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER,
  fail_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- Per-user Web Push event toggles (JSON array of event names). No row = every event the role can receive.
CREATE TABLE notification_prefs (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_events TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Last delivery of each admin channel (Admin → Notifications "last delivery").
CREATE TABLE notification_channel_status (
  channel         TEXT PRIMARY KEY,
  last_event      TEXT,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error      TEXT,
  last_error_at   INTEGER
);

-- Small internal state (e.g. the engine version an "update available" was already sent for).
CREATE TABLE notification_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
