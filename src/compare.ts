import { publicRun, type Run } from "./storage.js";

export function compareRuns(runs: Run[]) {
  const ordered = [...runs].sort((a, b) => b.start_utc.localeCompare(a.start_utc)).map(publicRun);
  const newest = ordered[0];
  const fields = ["pace_sec_per_km", "distance_m", "moving_s", "elapsed_s", "avg_hr_bpm", "avg_cadence_spm", "ascent_m"] as const;
  return {
    runs: ordered,
    comparisons: newest ? ordered.slice(1).map((older) => ({
      newer_id: newest.id,
      older_id: older.id,
      delta_newer_minus_older: Object.fromEntries(fields.map((field) => [field,
        newest[field] == null || older[field] == null ? null : newest[field] - older[field],
      ])),
    })) : [],
  };
}
