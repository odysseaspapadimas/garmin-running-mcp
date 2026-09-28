import { averageLapCadence } from "./laps.js";

export interface Env {
  DB: D1Database;
  ORIGINALS: R2Bucket;
  GARMIN_TOKEN_KEY: string;
  ACCESS_AUD: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_EMAIL: string;
}

export interface Run {
  id: string;
  start_utc: string;
  local_date: string;
  sport: string;
  name: string;
  distance_m: number | null;
  elapsed_s: number | null;
  moving_s: number | null;
  avg_hr_bpm: number | null;
  max_hr_bpm: number | null;
  avg_cadence_spm: number | null;
  ascent_m: number | null;
  descent_m: number | null;
  raw_summary: string;
  raw_detail?: string | null;
  raw_splits?: string | null;
  raw_laps?: string | null;
  raw_hr_zones?: string | null;
  updated_at: string;
}

function cadenceForRun(run: Run): number | null {
  if (run.avg_cadence_spm != null) return run.avg_cadence_spm;
  // Older cached runs predate the corrected Garmin field name; use their cached
  // summary first, then a moving-time-weighted lap average if necessary.
  const summary = run.raw_summary ? JSON.parse(run.raw_summary) as Record<string, unknown> : {};
  const value = summary.averageRunningCadenceInStepsPerMinute ?? summary.averageRunningCadenceInStepsPerMin;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return run.raw_laps ? averageLapCadence(JSON.parse(run.raw_laps)) : null;
}

export const publicRun = (run: Run) => ({
  id: run.id, start_utc: run.start_utc, local_date: run.local_date,
  sport: run.sport, name: run.name, distance_m: run.distance_m,
  elapsed_s: run.elapsed_s, moving_s: run.moving_s,
  pace_sec_per_km: run.distance_m && run.moving_s ? run.moving_s * 1000 / run.distance_m : null,
  avg_hr_bpm: run.avg_hr_bpm, max_hr_bpm: run.max_hr_bpm,
  avg_cadence_spm: cadenceForRun(run), ascent_m: run.ascent_m, descent_m: run.descent_m,
  updated_at: run.updated_at,
});

export function parseDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("Expected a valid YYYY-MM-DD date");
  }
  return date;
}

export async function listRuns(db: D1Database, start: string, end: string, limit = 50) {
  if (parseDate(start) > parseDate(end)) throw new Error("start must not be later than end");
  return (await db.prepare("SELECT * FROM runs WHERE local_date >= ? AND local_date <= ? ORDER BY start_utc DESC LIMIT ?")
    .bind(start, end, Math.min(Math.max(limit, 1), 100)).all<Run>()).results.map(publicRun);
}

export async function getRun(db: D1Database, id: string) {
  if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid activity id");
  return db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<Run>();
}

export async function syncStatus(db: D1Database) {
  const state = await db.prepare("SELECT key, value FROM sync_state").all<{ key: string; value: string }>();
  return Object.fromEntries(state.results.map(({ key, value }) => [key, value]));
}
