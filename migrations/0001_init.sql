CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  start_utc TEXT NOT NULL,
  local_date TEXT NOT NULL,
  sport TEXT NOT NULL,
  name TEXT NOT NULL,
  distance_m REAL,
  elapsed_s REAL,
  moving_s REAL,
  avg_hr_bpm REAL,
  max_hr_bpm REAL,
  avg_cadence_spm REAL,
  ascent_m REAL,
  descent_m REAL,
  raw_summary TEXT NOT NULL,
  raw_detail TEXT,
  raw_splits TEXT,
  raw_laps TEXT,
  raw_hr_zones TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_date_idx ON runs (start_utc DESC);
CREATE TABLE IF NOT EXISTS daily_metrics (
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(date, kind)
);
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS garmin_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
