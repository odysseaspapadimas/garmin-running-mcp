import { GarminConnectClient } from "@dofek/garmin-connect";
import type { ConnectActivitySummary, GarminTokens } from "@dofek/garmin-connect/types";
import { decryptTokens, encryptTokens } from "./crypto.js";
import { averageLapCadence } from "./laps.js";
import type { Env } from "./storage.js";

const BASE = "https://connectapi.garmin.com";
export const isRun = (a: ConnectActivitySummary) => /run|treadmill/i.test(a.activityType?.typeKey ?? "");
const n = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5000));

export function normalize(a: ConnectActivitySummary, now = new Date().toISOString()) {
  if (!Number.isSafeInteger(a.activityId) || !a.startTimeGMT || !a.startTimeLocal) throw new Error("Garmin activity schema changed");
  return {
    id: String(a.activityId), start_utc: a.startTimeGMT.replace(" ", "T") + (a.startTimeGMT.includes("Z") ? "" : "Z"),
    local_date: a.startTimeLocal.slice(0, 10), sport: a.activityType.typeKey,
    name: a.activityName ?? "Run", distance_m: n(a.distance),
    elapsed_s: n(a.elapsedDuration ?? a.duration), moving_s: n(a.movingDuration ?? a.duration),
    avg_hr_bpm: n(a.averageHR), max_hr_bpm: n(a.maxHR),
    // Garmin's live payload uses "StepsPerMinute"; the client type still says "StepsPerMin".
    avg_cadence_spm: n((a as ConnectActivitySummary & { averageRunningCadenceInStepsPerMinute?: number }).averageRunningCadenceInStepsPerMinute) ?? n(a.averageRunningCadenceInStepsPerMin),
    ascent_m: n(a.elevationGain), descent_m: n(a.elevationLoss),
    raw_summary: JSON.stringify(a), updated_at: now,
  };
}

export async function saveSession(db: D1Database, key: string, tokens: GarminTokens) {
  const encrypted = await encryptTokens(tokens, key);
  await db.prepare("INSERT INTO garmin_session (id, ciphertext, iv, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, updated_at=excluded.updated_at")
    .bind(encrypted.ciphertext, encrypted.iv, new Date().toISOString()).run();
}

const putState = (db: D1Database, key: string, value: string) => db.prepare("INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();

export async function getJson(accessToken: string, path: string): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "GCM-iOS-5.19.1.2" } });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Garmin API HTTP ${response.status}`);
  return response.json();
}

async function storeActivity(env: Env, client: GarminConnectClient, a: ConnectActivitySummary, force: boolean) {
  const run = normalize(a);
  const existing = await env.DB.prepare("SELECT raw_summary,raw_detail FROM runs WHERE id=?").bind(run.id).first<{raw_summary: string;raw_detail: string | null}>();
  const key = `originals/${run.id}.zip`; // Garmin's original activity endpoint returns a ZIP, usually containing FIT.
  const original = await env.ORIGINALS.head(key);
  if (!force && existing?.raw_summary === run.raw_summary && existing.raw_detail && original) return;
  const token = client.getTokens()?.oauth2.access_token;
  if (!token) throw new Error("Garmin session unavailable");
  // Chart response is sampled, has NO polyline; preserve original binary privately in R2.
  await pause();
  const detail = await client.getActivityDetail(a.activityId, 500, 0);
  await pause();
  const splits = await getJson(token, `/activity-service/activity/${run.id}/split_summaries`);
  await pause();
  const laps = await getJson(token, `/activity-service/activity/${run.id}/splits`);
  run.avg_cadence_spm ??= averageLapCadence(laps);
  await pause();
  const zones = await getJson(token, `/activity-service/activity/${run.id}/hrTimeInZones`);
  if (!original) {
    await pause();
    const fit = await client.downloadFitFile(a.activityId);
    await env.ORIGINALS.put(key, fit, { httpMetadata: { contentType: "application/octet-stream" } });
  }
  await env.DB.prepare(`INSERT INTO runs (id,start_utc,local_date,sport,name,distance_m,elapsed_s,moving_s,avg_hr_bpm,max_hr_bpm,avg_cadence_spm,ascent_m,descent_m,raw_summary,raw_detail,raw_splits,raw_laps,raw_hr_zones,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    start_utc=excluded.start_utc,local_date=excluded.local_date,sport=excluded.sport,name=excluded.name,
    distance_m=excluded.distance_m,elapsed_s=excluded.elapsed_s,moving_s=excluded.moving_s,
    avg_hr_bpm=excluded.avg_hr_bpm,max_hr_bpm=excluded.max_hr_bpm,avg_cadence_spm=excluded.avg_cadence_spm,
    ascent_m=excluded.ascent_m,descent_m=excluded.descent_m,raw_summary=excluded.raw_summary,
    raw_detail=excluded.raw_detail,raw_splits=excluded.raw_splits,raw_laps=excluded.raw_laps,raw_hr_zones=excluded.raw_hr_zones,updated_at=excluded.updated_at`)
    .bind(run.id,run.start_utc,run.local_date,run.sport,run.name,run.distance_m,run.elapsed_s,run.moving_s,run.avg_hr_bpm,run.max_hr_bpm,run.avg_cadence_spm,run.ascent_m,run.descent_m,run.raw_summary,JSON.stringify(detail),JSON.stringify(splits),JSON.stringify(laps),JSON.stringify(zones),run.updated_at).run();
}

async function storeMetrics(env: Env, client: GarminConnectClient, day: string) {
  for (const [kind, method] of [
    ["readiness", () => client.getTrainingReadiness(day)],
    ["hrv", () => client.getHrvSummary(day)],
    ["daily", () => client.getDailySummary(day)],
  ] as const) {
    try {
      await pause();
      const metric = await method();
      await env.DB.prepare("INSERT INTO daily_metrics(date,kind,raw_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(date,kind) DO UPDATE SET raw_json=excluded.raw_json,updated_at=excluded.updated_at")
        .bind(day,kind,JSON.stringify(metric ?? null),new Date().toISOString()).run();
    } catch (error) { // Missing device-dependent metrics should not abort; auth/rate limits must.
      const message = error instanceof Error ? error.message : "";
      if (/401|403|429|rate|auth|token/i.test(message)) throw error;
      await putState(env.DB, `missing_${kind}`, day);
    }
  }
}

export async function syncOnce(env: Env) {
  const row = await env.DB.prepare("SELECT ciphertext,iv FROM garmin_session WHERE id=1").first<{ciphertext: string;iv: string}>();
  if (!row) { await putState(env.DB, "status", "needs_initial_login"); return; }
  // Prevent overlapping cron jobs; lease expires even if a previous Worker died.
  const lease = String(Date.now() + 5 * 60_000);
  const acquired = await env.DB.prepare("INSERT INTO sync_state(key,value) VALUES('lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(sync_state.value AS INTEGER) < ?")
    .bind(lease, Date.now()).run();
  if (!acquired.meta.changes) return;
  // Persist only a fixed checkpoint on failure, never a third-party exception or request data.
  let stage = "decrypt_session";
  try {
    const tokens = await decryptTokens(row.ciphertext, row.iv, env.GARMIN_TOKEN_KEY);
    stage = "create_client";
    const clientFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const endpoint = url.hostname === "thegarth.s3.amazonaws.com" ? "consumer" :
        url.pathname.endsWith("/exchange/user/2.0") ? "exchange" : "profile";
      stage = `create_client_${endpoint}_request`;
      try {
        const response = await fetch(input, init);
        stage = `create_client_${endpoint}_http_${response.status}`;
        return response;
      } catch {
        stage = `create_client_${endpoint}_network`;
        throw new Error("Garmin client fetch failed");
      }
    };
    const client = await GarminConnectClient.fromTokens(tokens, "garmin.com", clientFetch);
    stage = "save_session";
    // Persist a refreshed token immediately, before activity/API errors can occur.
    await saveSession(env.DB, env.GARMIN_TOKEN_KEY, client.getTokens()!);
    stage = "fetch_recent";
    const recent = (await client.getActivities(0, 25)).filter(isRun).slice(0, 4);
    stage = "store_recent";
    for (const a of recent) await storeActivity(env, client, a, false);
    stage = "read_backfill";
    const state = await env.DB.prepare("SELECT value FROM sync_state WHERE key='backfill_offset'").first<{value: string}>();
    const offset = Number(state?.value ?? 0);
    if (Number.isSafeInteger(offset) && offset >= 0) {
      stage = "fetch_backfill";
      await pause();
      // Four activities per pass keeps imported history moving without sending
      // a burst of detail/FIT requests; storeActivity spaces calls by 5s.
      const batch = await client.getActivities(offset, 4);
      stage = "store_backfill";
      for (const a of batch.filter(isRun)) await storeActivity(env, client, a, false);
      stage = "save_backfill";
      await putState(env.DB, "backfill_offset", batch.length < 4 ? "complete" : String(offset + 4));
    }
    // UTC days are a fallback: a dedicated Garmin-local timezone should be set after the live account probe.
    const dates = [0, 1].map((days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10));
    stage = "store_metrics";
    for (const day of dates) await storeMetrics(env, client, day);
    stage = "finish_sync";
    await saveSession(env.DB, env.GARMIN_TOKEN_KEY, client.getTokens()!);
    await putState(env.DB, "last_success", new Date().toISOString());
    await putState(env.DB, "status", "ok");
    await env.DB.prepare("DELETE FROM sync_state WHERE key='last_error_stage'").run();
  } catch (error) {
    // Do not persist or log library exception bodies; they can contain tokens or URLs.
    const category = error instanceof Error && /auth|token|login|401/i.test(error.message) ? "needs_reauthentication" :
      error instanceof Error && /429|rate/i.test(error.message) ? "rate_limited" : "upstream_error";
    await putState(env.DB, "status", category);
    await putState(env.DB, "last_error_stage", stage);
    throw new Error(`Garmin sync: ${category} at ${stage}`);
  } finally {
    await env.DB.prepare("DELETE FROM sync_state WHERE key='lease' AND value=?").bind(lease).run();
  }
}
