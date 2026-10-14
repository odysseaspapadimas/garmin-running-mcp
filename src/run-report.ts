import { safeChart, safeDetail } from "./detail.js";
import { safeLaps } from "./laps.js";
import { safeSplitSummaries } from "./split-summaries.js";
import { publicRun, type Run } from "./storage.js";

// SQL NULL means never fetched; JSON null/empty means Garmin returned no data.
// Neither proves that Garmin will never finish processing this activity.
export function hrZones(raw: string | null | undefined) {
  if (!raw) return { status: "not_fetched" as const, zones: null };
  const value: unknown = JSON.parse(raw);
  if (value == null || (Array.isArray(value) && !value.length)) return { status: "unavailable" as const, zones: null };
  if (!Array.isArray(value)) return { status: "unrecognized_response" as const, zones: null };
  const zones = value.filter((row) => row && Number.isInteger(row.zoneNumber) && row.zoneNumber >= 1 && row.zoneNumber <= 5 &&
    typeof row.secsInZone === "number" && Number.isFinite(row.secsInZone) && row.secsInZone >= 0)
    .map((row) => ({ zoneNumber: row.zoneNumber as number, secsInZone: row.secsInZone as number,
      zoneLowBoundary: typeof row.zoneLowBoundary === "number" && Number.isFinite(row.zoneLowBoundary) ? row.zoneLowBoundary as number : null }));
  return zones.length === value.length ? { status: "available" as const, zones } : { status: "unrecognized_response" as const, zones: null };
}

export function runReport(run: Run) {
  const laps = safeLaps(run.raw_laps ? JSON.parse(run.raw_laps) : null);
  const zones = hrZones(run.raw_hr_zones);
  const chartAvailable = safeChart(run.raw_detail, 0, 1).samples.length > 0;
  const dataStatus = {
    laps: laps.length ? "available" : run.raw_laps ? "unavailable" : "not_fetched",
    hr_zones: zones.status,
    chart: chartAvailable ? "available" : run.raw_detail ? "unavailable" : "not_fetched",
  };
  return { ...publicRun(run), ...safeDetail(run.raw_summary),
    details_pending: dataStatus.laps !== "available",
    full_details_pending: Object.values(dataStatus).some((status) => status !== "available"),
    data_status: dataStatus, laps,
    split_group_summaries: run.raw_splits ? safeSplitSummaries(JSON.parse(run.raw_splits)) : null,
    hr_time_in_zones: zones.zones,
    hr_zone_source: zones.status === "available" ? "garmin_time_in_zones" : null,
    hr_zone_note: "Use Garmin's seconds in each zone, not kilometer-average HR, for time-in-zone reporting. Unavailable means no data returned on the last fetch; Garmin may still be processing it. Do not infer zone boundaries from a run's average or maximum HR." };
}
