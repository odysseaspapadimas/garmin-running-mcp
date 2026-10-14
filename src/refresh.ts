import { GarminConnectClient } from "@dofek/garmin-connect";
import type { GarminTokens } from "@dofek/garmin-connect/types";
import { decryptTokens } from "./crypto.js";
import { getJson, isRun, normalize, saveSession } from "./garmin.js";
import { averageLapCadence } from "./laps.js";
import { runReport } from "./run-report.js";
import { publicRun, type Env, type Run } from "./storage.js";

const COOLDOWN_MS = 60_000;
const LEASE_MS = 2 * 60_000;
const state = (db: D1Database, key: string, value: string) => db.prepare(
  "INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
).bind(key, value).run();
const latest = (db: D1Database) => db.prepare("SELECT * FROM runs ORDER BY start_utc DESC LIMIT 1").first<Run>();

type Client = Pick<GarminConnectClient, "getActivities" | "getTokens" | "getActivityDetail">;
export interface RefreshOptions {
  now?: () => number;
  fromTokens?: (tokens: GarminTokens, fetchFn: typeof fetch) => Promise<Client>;
  getLaps?: (accessToken: string, id: string) => Promise<unknown>;
  getZones?: (accessToken: string, id: string) => Promise<unknown>;
  getDetail?: (id: number) => Promise<unknown>;
  wait?: () => Promise<void>;
}

// On-demand post-run sync: summary, laps, HR zones and bounded chart data.
// No FIT downloads, recovery or historical pagination. Missing detail is retried
// on the next explicit refresh, even when the activity summary is unchanged.
export async function refreshLatestRun(env: Env, options: RefreshOptions = {}) {
  const now = (options.now ?? Date.now)();
  const lease = String(now + LEASE_MS);
  // A shared D1 lease prevents concurrent refreshes (or legacy maintenance)
  // from refreshing/saving Garmin tokens at the same time.
  const acquired = await env.DB.prepare("INSERT INTO sync_state(key,value) VALUES('lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(sync_state.value AS INTEGER) < ?")
    .bind(lease, now).run();
  if (!acquired.meta.changes) {
    const cached = await latest(env.DB);
    return { status: "busy", latest_run: cached ? publicRun(cached) : null, ...(cached ? runReport(cached) : {}) };
  }
  try {
    const cached = await latest(env.DB);
    const view = () => cached ? publicRun(cached) : null;
    const attempt = await env.DB.prepare("SELECT value FROM sync_state WHERE key='refresh_latest_attempt'").first<{ value: string }>();
    const lastAttempt = Number(attempt?.value);
    if (attempt && Number.isFinite(lastAttempt) && now - lastAttempt < COOLDOWN_MS && now >= lastAttempt) {
      return { status: "cooldown", retry_after_seconds: Math.ceil((COOLDOWN_MS - (now - lastAttempt)) / 1000), latest_run: view(), ...(cached ? runReport(cached) : {}) };
    }
    const row = await env.DB.prepare("SELECT ciphertext,iv FROM garmin_session WHERE id=1").first<{ ciphertext: string; iv: string }>();
    if (!row) return { status: "needs_initial_login", latest_run: view() };
    await state(env.DB, "refresh_latest_attempt", String(now));
    // Only fixed stage names and numeric HTTP codes are stored; no Garmin
    // exception body, token, request header, URL or activity is exposed.
    let stage = "decrypt_session";
    let phase = "create_client";
    const clientFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const endpoint = url.hostname === "thegarth.s3.amazonaws.com" ? "consumer" :
        url.pathname.endsWith("/exchange/user/2.0") ? "oauth_exchange" :
        url.pathname.endsWith("/socialProfile") ? "profile" :
        url.pathname.endsWith("/activities/search/activities") ? "activities" : "other";
      stage = `${phase}_${endpoint}_request`;
      try {
        const response = await fetch(input, init);
        stage = `${phase}_${endpoint}_http_${response.status}`;
        return response;
      } catch {
        stage = `${phase}_${endpoint}_network`;
        throw new Error("Garmin client fetch failed");
      }
    };
    try {
      const tokens = await decryptTokens(row.ciphertext, row.iv, env.GARMIN_TOKEN_KEY);
      stage = "create_client";
      const client = await (options.fromTokens ?? ((value, fetchFn) => GarminConnectClient.fromTokens(value, "garmin.com", fetchFn)))(tokens, clientFetch);
      stage = "save_session";
      const renewed = client.getTokens();
      if (!renewed) throw new Error("Garmin token unavailable");
      await saveSession(env.DB, env.GARMIN_TOKEN_KEY, renewed);
      phase = "fetch_latest";
      stage = "fetch_latest";
      const run = (await client.getActivities(0, 5)).find(isRun);
      stage = "save_refreshed_session";
      const currentTokens = client.getTokens();
      if (currentTokens?.oauth2.access_token !== renewed.oauth2.access_token && currentTokens) {
        await saveSession(env.DB, env.GARMIN_TOKEN_KEY, currentTokens);
      }
      if (!run) {
        await state(env.DB, "refresh_latest_status", "no_run_found");
        await env.DB.prepare("DELETE FROM sync_state WHERE key='refresh_latest_error_stage'").run();
        return { status: "no_run_found", latest_run: view(), checked_at: new Date(now).toISOString() };
      }
      stage = "normalize_run";
      const normalized = normalize(run);
      // Garmin sometimes needs time to process a just-finished run. An older
      // result must not replace the newest cached run or masquerade as new.
      if (cached && normalized.start_utc < cached.start_utc) {
        await state(env.DB, "refresh_latest_status", "no_new_run");
        await env.DB.prepare("DELETE FROM sync_state WHERE key='refresh_latest_error_stage'").run();
        return { status: "no_new_run", latest_run: view(), checked_at: new Date(now).toISOString() };
      }
      const changed = !cached || normalized.id !== cached.id || normalized.raw_summary !== cached.raw_summary;
      if (changed) {
        stage = "cache_summary";
        await env.DB.prepare(`INSERT INTO runs (id,start_utc,local_date,sport,name,distance_m,elapsed_s,moving_s,avg_hr_bpm,max_hr_bpm,avg_cadence_spm,ascent_m,descent_m,raw_summary,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          start_utc=excluded.start_utc,local_date=excluded.local_date,sport=excluded.sport,name=excluded.name,
          distance_m=excluded.distance_m,elapsed_s=excluded.elapsed_s,moving_s=excluded.moving_s,
          avg_hr_bpm=excluded.avg_hr_bpm,max_hr_bpm=excluded.max_hr_bpm,avg_cadence_spm=excluded.avg_cadence_spm,
          ascent_m=excluded.ascent_m,descent_m=excluded.descent_m,updated_at=excluded.updated_at,
          raw_detail=CASE WHEN runs.raw_summary=excluded.raw_summary THEN runs.raw_detail ELSE NULL END,
          raw_splits=CASE WHEN runs.raw_summary=excluded.raw_summary THEN runs.raw_splits ELSE NULL END,
          raw_laps=CASE WHEN runs.raw_summary=excluded.raw_summary THEN runs.raw_laps ELSE NULL END,
          raw_hr_zones=CASE WHEN runs.raw_summary=excluded.raw_summary THEN runs.raw_hr_zones ELSE NULL END,
          raw_summary=excluded.raw_summary`)
          .bind(normalized.id, normalized.start_utc, normalized.local_date, normalized.sport, normalized.name,
            normalized.distance_m, normalized.elapsed_s, normalized.moving_s, normalized.avg_hr_bpm,
            normalized.max_hr_bpm, normalized.avg_cadence_spm, normalized.ascent_m, normalized.descent_m,
            normalized.raw_summary, normalized.updated_at).run();
      }
      let current = changed ? await latest(env.DB) : cached;
      let detailsUpdated = false;
      if (current && runReport(current).data_status.laps !== "available") {
        stage = "fetch_laps";
        await (options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 5000))))();
        const accessToken = client.getTokens()?.oauth2.access_token;
        if (!accessToken) throw new Error("Garmin session unavailable");
        const laps = await (options.getLaps ?? ((token, runId) => getJson(token, `/activity-service/activity/${runId}/splits`)))(accessToken, current.id);
        stage = "cache_laps";
        await env.DB.prepare("UPDATE runs SET raw_laps=?,avg_cadence_spm=COALESCE(avg_cadence_spm,?) WHERE id=?")
          .bind(JSON.stringify(laps ?? null), averageLapCadence(laps), current.id).run();
        current = await latest(env.DB);
        detailsUpdated ||= !!current && runReport(current).data_status.laps === "available";
      }
      if (current && runReport(current).data_status.hr_zones !== "available") {
        stage = "fetch_hr_zones";
        await (options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 5000))))();
        const accessToken = client.getTokens()?.oauth2.access_token;
        if (!accessToken) throw new Error("Garmin session unavailable");
        const zones = await (options.getZones ?? ((token, runId) => getJson(token, `/activity-service/activity/${runId}/hrTimeInZones`)))(accessToken, current.id);
        stage = "cache_hr_zones";
        await env.DB.prepare("UPDATE runs SET raw_hr_zones=? WHERE id=?").bind(JSON.stringify(zones ?? null), current.id).run();
        current = await latest(env.DB);
        detailsUpdated ||= !!current && runReport(current).data_status.hr_zones === "available";
      }
      if (current && runReport(current).data_status.chart !== "available") {
        stage = "fetch_chart";
        await (options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 5000))))();
        const detail = await (options.getDetail ?? ((id) => client.getActivityDetail(id, 500, 0)))(Number(current.id));
        stage = "cache_chart";
        await env.DB.prepare("UPDATE runs SET raw_detail=? WHERE id=?").bind(JSON.stringify(detail ?? null), current.id).run();
        current = await latest(env.DB);
        detailsUpdated ||= !!current && runReport(current).data_status.chart === "available";
      }
      stage = "save_detail_session";
      const finalTokens = client.getTokens();
      if (finalTokens) await saveSession(env.DB, env.GARMIN_TOKEN_KEY, finalTokens);
      stage = "finish_refresh";
      const updated = changed || detailsUpdated;
      await state(env.DB, "refresh_latest_status", updated ? "updated" : "no_new_run");
      await env.DB.prepare("DELETE FROM sync_state WHERE key='refresh_latest_error_stage'").run();
      return { status: updated ? "updated" : "no_new_run", checked_at: new Date(now).toISOString(),
        latest_run: current ? publicRun(current) : null,
        ...(current ? runReport(current) : {}),
        ...(current && runReport(current).full_details_pending
          ? { note: "Some run data is not available yet. Try an explicit refresh later; Garmin may still be processing it." }
          : updated ? {} : { note: "No newer run is visible in Garmin yet." }) };
    } catch (error) {
      // Unofficial clients may include tokens or request headers in errors.
      // Expose only a fixed category, never the exception or its stack.
      const message = error instanceof Error ? error.message : "";
      const category = /429|rate/i.test(message) ? "rate_limited" :
        /401|403|auth|token/i.test(message) ? "needs_reauthentication" : "upstream_error";
      await state(env.DB, "refresh_latest_status", category);
      await state(env.DB, "refresh_latest_error_stage", stage);
      // Preserve and report any detail cached before a later request failed.
      const current = await latest(env.DB);
      return { status: category, latest_run: current ? publicRun(current) : null,
        ...(current ? runReport(current) : {}), checked_at: new Date(now).toISOString() };
    }
  } finally {
    await env.DB.prepare("DELETE FROM sync_state WHERE key='lease' AND value=?").bind(lease).run();
  }
}
