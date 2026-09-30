import { describe, expect, it, vi } from "vitest";
import { encryptTokens } from "../src/crypto.js";
import { refreshLatestRun } from "../src/refresh.js";
import type { Env, Run } from "../src/storage.js";
import type { ConnectActivitySummary, GarminTokens } from "@dofek/garmin-connect/types";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(27)));
const now = Date.parse("2026-09-25T12:00:00Z");
const tokens: GarminTokens = {
  oauth1: { oauth_token: "test-1", oauth_token_secret: "test-secret" },
  oauth2: { scope: "", jti: "", token_type: "Bearer", access_token: "test-2", refresh_token: "test-refresh", expires_in: 3600, expires_at: 9999999999, refresh_token_expires_in: 3600, refresh_token_expires_at: 9999999999 },
  displayName: "runner",
};
const activity = { activityId: 321, activityName: "Run", activityType: { typeId: 1, typeKey: "running" }, startTimeGMT: "2026-09-25 08:00:00", startTimeLocal: "2026-09-25 11:00:00", duration: 1800, distance: 5000, movingDuration: 1800, averageHR: 160 } as ConnectActivitySummary;

function fakeDb(session: { ciphertext: string; iv: string }) {
  const values: Record<string, string> = {};
  let run: Run | null = null;
  let garminSession = session;
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { params = args; return stmt; },
        async first() {
          if (sql.includes("SELECT * FROM runs")) return run;
          if (sql.includes("SELECT ciphertext,iv")) return garminSession;
          if (sql.includes("SELECT value FROM sync_state")) return values.refresh_latest_attempt ? { value: values.refresh_latest_attempt } : null;
          return null;
        },
        async run() {
          if (sql.includes("VALUES('lease'")) {
            if (values.lease && Number(values.lease) >= Number(params[1])) return { meta: { changes: 0 } };
            values.lease = String(params[0]); return { meta: { changes: 1 } };
          }
          if (sql.includes("DELETE FROM sync_state")) {
            if (values.lease === params[0]) delete values.lease;
          } else if (sql.includes("INSERT INTO sync_state")) {
            values[String(params[0])] = String(params[1]);
          } else if (sql.includes("INSERT INTO garmin_session")) {
            garminSession = { ciphertext: String(params[0]), iv: String(params[1]) };
          } else if (sql.includes("UPDATE runs SET raw_laps")) {
            if (run) run = { ...run, raw_laps: String(params[0]), avg_cadence_spm: Number(params[1]) };
          } else if (sql.includes("INSERT INTO runs")) {
            run = { id: String(params[0]), start_utc: String(params[1]), local_date: String(params[2]), sport: String(params[3]),
              name: String(params[4]), distance_m: Number(params[5]), elapsed_s: Number(params[6]), moving_s: Number(params[7]),
              avg_hr_bpm: Number(params[8]), max_hr_bpm: null, avg_cadence_spm: null, ascent_m: null, descent_m: null,
              raw_summary: String(params[13]), raw_detail: null, updated_at: String(params[14]) };
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { env: { DB: db, GARMIN_TOKEN_KEY: key } as Env, values, getRun: () => run };
}

describe("manual latest-run refresh", () => {
  it("checks recent activities and lap splits, caches both, then enforces a one-minute cooldown", async () => {
    const { ciphertext, iv } = await encryptTokens(tokens, key);
    const { env, values, getRun } = fakeDb({ ciphertext, iv });
    let requests = 0;
    const fromTokens = async (decrypted: GarminTokens) => {
      expect(decrypted.oauth1.oauth_token).toBe("test-1");
      return { getTokens: () => tokens, getActivities: async (_offset: number, limit: number) => {
        expect(limit).toBe(5);
        requests++;
        return [activity];
      } } as never;
    };
    const getLaps = async () => ({ lapDTOs: [{ distance: 1000, movingDuration: 360, averageHR: 160, startLatitude: 40 }] });
    const first = await refreshLatestRun(env, { now: () => now, fromTokens, getLaps, wait: async () => {} });
    expect(first.status).toBe("updated");
    expect(first.latest_run?.pace_sec_per_km).toBe(360);
    expect("details_pending" in first && first.details_pending).toBe(false);
    expect("laps" in first && first.laps).toMatchObject([{ pace_sec_per_km: 360 }]);
    expect(JSON.stringify(first)).not.toContain("startLatitude");
    expect(getRun()?.raw_detail).toBeNull();
    expect(values.lease).toBeUndefined();
    const second = await refreshLatestRun(env, { now: () => now + 30_000, fromTokens, getLaps, wait: async () => {} });
    expect(second.status).toBe("cooldown");
    expect(second.retry_after_seconds).toBe(30);
    expect(requests).toBe(1);
    const third = await refreshLatestRun(env, { now: () => now + 60_000, fromTokens, getLaps, wait: async () => {} });
    expect(third.status).toBe("no_new_run");
    expect("note" in third && third.note).toContain("No newer run");
    expect(requests).toBe(2);
  });
  it("enriches laps later when Garmin initially has no lap data", async () => {
    const session = await encryptTokens(tokens, key);
    const { env, getRun } = fakeDb(session);
    const fromTokens = async () => ({ getTokens: () => tokens, getActivities: async () => [activity] }) as never;
    const empty = await refreshLatestRun(env, { now: () => now, fromTokens, getLaps: async () => null, wait: async () => {} });
    expect(empty.status).toBe("updated");
    expect("details_pending" in empty && empty.details_pending).toBe(true);
    const completed = await refreshLatestRun(env, { now: () => now + 60_000, fromTokens,
      getLaps: async () => ({ lapDTOs: [{ distance: 1000, movingDuration: 350 }] }), wait: async () => {} });
    expect(completed.status).toBe("updated");
    expect("details_pending" in completed && completed.details_pending).toBe(false);
    expect(getRun()?.raw_laps).toContain("lapDTOs");
  });
  it("returns busy without calling Garmin when the scheduled sync holds the lease", async () => {
    const session = await encryptTokens(tokens, key);
    const { env, values } = fakeDb(session);
    values.lease = String(now + 300_000);
    const result = await refreshLatestRun(env, { now: () => now, fromTokens: async () => { throw new Error("must not call Garmin"); } });
    expect(result.status).toBe("busy");
    expect(values.refresh_latest_attempt).toBeUndefined();
  });
  it("records only a fixed HTTP checkpoint for an upstream failure", async () => {
    const session = await encryptTokens(tokens, key);
    const { env, values } = fakeDb(session);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private request content", { status: 503 }));
    try {
      const result = await refreshLatestRun(env, { now: () => now, fromTokens: async (_tokens, safeFetch) => {
        const response = await safeFetch("https://thegarth.s3.amazonaws.com/oauth_consumer.json");
        if (!response.ok) throw new Error("upstream failed with private request content");
        throw new Error("test must not succeed");
      } });
      expect(result.status).toBe("upstream_error");
      expect(values.refresh_latest_error_stage).toBe("create_client_consumer_http_503");
      expect(JSON.stringify(result)).not.toContain("private request content");
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("returns a fixed error category without leaking upstream exception bodies", async () => {
    const session = await encryptTokens(tokens, key);
    const { env, values } = fakeDb(session);
    const result = await refreshLatestRun(env, { now: () => now, fromTokens: async () => { throw new Error("request contained sensitive token"); } });
    expect(result.status).toBe("needs_reauthentication");
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(values.lease).toBeUndefined();
  });
});
