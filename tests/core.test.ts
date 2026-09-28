import { describe, expect, it } from "vitest";
import { normalize, syncOnce } from "../src/garmin.js";
import { averageLapCadence, safeLaps } from "../src/laps.js";
import { safeChart, safeDetail } from "../src/detail.js";
import { safeSplitSummaries } from "../src/split-summaries.js";
import { compareRuns } from "../src/compare.js";
import { decryptTokens, encryptTokens } from "../src/crypto.js";
import { parseDate, publicRun, type Env } from "../src/storage.js";
import worker from "../src/worker.js";
import type { ConnectActivitySummary, GarminTokens } from "@dofek/garmin-connect/types";

const tokens: GarminTokens = {
  oauth1: { oauth_token: "private-1", oauth_token_secret: "private-secret" },
  oauth2: { scope: "", jti: "", token_type: "Bearer", access_token: "private-2", refresh_token: "private-refresh", expires_in: 3600, expires_at: 9999999999, refresh_token_expires_in: 3600, refresh_token_expires_at: 9999999999 },
  displayName: "runner",
};
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)));

describe("security and normalization", () => {
  it("encrypts renewable tokens using fresh nonces; rejects a wrong key", async () => {
    const first = await encryptTokens(tokens, key);
    const second = await encryptTokens(tokens, key);
    expect(first.ciphertext).not.toContain("private");
    expect(first.iv).not.toBe(second.iv);
    expect(await decryptTokens(first.ciphertext, first.iv, key)).toEqual(tokens);
    await expect(decryptTokens(first.ciphertext, first.iv, btoa(String.fromCharCode(...new Uint8Array(32).fill(18))))).rejects.toThrow();
  });
  it("preserves duration units, nulls and excludes GPS coordinates from public output", () => {
    const activity = { activityId: 321, activityName: "Easy run", activityType: { typeId: 1, typeKey: "running" }, startTimeGMT: "2026-09-20 08:00:00", startTimeLocal: "2026-09-20 11:00:00", duration: 1900, distance: 5000, movingDuration: 1800, averageRunningCadenceInStepsPerMinute: 151.1875, startLatitude: 40.0 } as ConnectActivitySummary;
    const run = normalize(activity);
    expect(run.local_date).toBe("2026-09-20");
    expect(run.start_utc).toBe("2026-09-20T08:00:00Z");
    expect(publicRun(run).pace_sec_per_km).toBe(360);
    expect(publicRun(run).avg_cadence_spm).toBe(151.1875);
    expect(JSON.stringify(publicRun(run))).not.toContain("Latitude");
    expect(publicRun(run).avg_hr_bpm).toBeNull();
  });
  it("exposes per-lap pacing without precise location", () => {
    const laps = safeLaps({ lapDTOs: [{ lapIndex: 1, distance: 1000, movingDuration: 355, duration: 360, averageHR: 148, averageRunCadence: 172, startLatitude: 40.1, startLongitude: 23.1 }] });
    expect(laps[0].pace_sec_per_km).toBe(355);
    expect(JSON.stringify(laps)).not.toContain("Latitude");
    expect(averageLapCadence({ lapDTOs: [
      { averageRunCadence: 160, movingDuration: 400 }, { averageRunCadence: 140, movingDuration: 200 },
      { averageRunCadence: 0, movingDuration: 100 },
    ] })).toBeCloseTo(153.333);
    expect(averageLapCadence({ lapDTOs: [{ movingDuration: 200 }] })).toBeNull();
  });
  it("does not expose unknown split summary fields or GPS locations", () => {
    const result = safeSplitSummaries({ activityId: 321, startLatitude: 41, splitSummaries: [
      { splitType: "RUN", distance: 1000, duration: 360, startLongitude: 23, locationName: "Home" },
    ] });
    expect(result).toEqual({ splitSummaries: [{ splitType: "RUN", distance: 1000, duration: 360 }] });
    expect(JSON.stringify(result)).not.toContain("Latitude");
    expect(JSON.stringify(result)).not.toContain("Longitude");
  });
  it("omits charts from details and paginates opt-in chart metrics without location", () => {
    const detail = safeDetail(JSON.stringify({ calories: 300, startLatitude: 45, locationName: "Home" }));
    const chart = safeChart(JSON.stringify({
      geoPolylineDTO: { polyline: [{ lat: 45, lon: 20 }] },
      metricDescriptors: [{ metricsIndex: 0, key: "directHeartRate" }, { metricsIndex: 1, key: "directLatitude" }],
      activityDetailMetrics: [{ metrics: [145, 45] }, { metrics: [150, 46] }],
    }), 0, 1);
    expect(detail).toEqual({ extra_summary: { calories: 300 } });
    expect(chart.samples).toEqual([{ directHeartRate: 145 }]);
    expect(chart.next_offset).toBe(1);
    expect(JSON.stringify(chart)).not.toContain("Latitude");
  });
  it("computes newest-minus-older deltas with nulls preserved", () => {
    const older = { id: "1", start_utc: "2026-09-20T08:00:00Z", moving_s: 1500, elapsed_s: 1500, distance_m: 3150, avg_hr_bpm: 170, avg_cadence_spm: null, ascent_m: null };
    const newer = { ...older, id: "2", start_utc: "2026-09-24T08:00:00Z", moving_s: 1470, avg_hr_bpm: 158, raw_summary: JSON.stringify({ averageRunningCadenceInStepsPerMinute: 151 }) };
    const comparison = compareRuns([older, newer] as Parameters<typeof compareRuns>[0]);
    expect(comparison.comparisons[0].newer_id).toBe("2");
    expect(comparison.comparisons[0].delta_newer_minus_older).toMatchObject({ avg_hr_bpm: -12, avg_cadence_spm: null });
    expect(comparison.comparisons[0].delta_newer_minus_older.pace_sec_per_km).toBeCloseTo(-30 * 1000 / 3150);
  });
  it("validates dates, not just their format", () => {
    expect(() => parseDate("2026-02-30")).toThrow();
    expect(() => parseDate("2026-09-20")).not.toThrow();
  });
  it("rejects unauthenticated MCP calls before any data access", async () => {
    const result = await worker.fetch(new Request("https://example.workers.dev/mcp"), {} as Env, {} as ExecutionContext);
    expect(result.status).toBe(401);
  });
  it("reports missing initial login without making Garmin calls", async () => {
    const records: Record<string, string> = {};
    const db = {
      prepare: (sql: string) => ({
        first: async () => sql.includes("garmin_session") ? null : null,
        bind: (key: string, value: string) => ({ run: async () => { records[key] = value; } }),
      }),
    } as unknown as D1Database;
    await syncOnce({ DB: db } as Env);
    expect(records.status).toBe("needs_initial_login");
  });
});
