import { expect, it } from "vitest";
import { handleMcp } from "../src/mcp.js";
import type { Env } from "../src/storage.js";

it("exposes bounded cached tools and one explicit refresh through the MCP transport", async () => {
  const env = { DB: {
    prepare(sql: string) {
      const statement = {
        first: async () => sql.includes("FROM runs") ? { id: "321", name: "Easy", sport: "running", start_utc: "2026-09-20T08:00:00Z", local_date: "2026-09-20", distance_m: 5000, moving_s: 1800, elapsed_s: 1900, avg_hr_bpm: null, max_hr_bpm: null, avg_cadence_spm: null, ascent_m: null, descent_m: null, raw_summary: '{"calories":300}', raw_detail: '{"metricDescriptors":[{"metricsIndex":0,"key":"heartRate"}],"activityDetailMetrics":[{"metrics":[145]}]}', raw_laps: '{"lapDTOs":[{"distance":1000,"movingDuration":355,"startLatitude":40}]}', updated_at: "2026-09-21" } : null,
        bind: () => statement,
      };
      return statement;
    },
  } } as unknown as Env;
  const request = (id: number, method: string, params: unknown = {}) => new Request("http://localhost:8787/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Host: "localhost:8787" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const decode = async (response: Response) => {
    const text = await response.text();
    return JSON.parse(text.startsWith("event:") ? text.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : text);
  };
  const initialized = await handleMcp(request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }), env, ctx);
  expect(initialized.status, await initialized.clone().text()).toBe(200);
  const tools = await handleMcp(request(2, "tools/list"), env, ctx);
  expect(tools.status).toBe(200);
  const toolList = ((await decode(tools)) as {result: {tools: {name: string; annotations?: {readOnlyHint?: boolean}}[]}}).result.tools;
  const names = toolList.map((tool) => tool.name);
  expect(names).toContain("latest_run");
  expect(toolList.find((tool) => tool.name === "refresh_latest_run")?.annotations?.readOnlyHint).toBe(false);
  expect(names).toContain("running_trends");
  expect(names).toContain("run_chart");
  expect(names.every((name) => !/sync|upload|write|delete|garmin_login/i.test(name) || name === "sync_status")).toBe(true);
  const run = await handleMcp(request(3, "tools/call", { name: "latest_run", arguments: {} }), env, ctx);
  expect(run.status).toBe(200);
  expect(await run.text()).toContain("360");
  const details = await decode(await handleMcp(request(4, "tools/call", { name: "run_details", arguments: { id: "321" } }), env, ctx));
  const detailText = JSON.stringify(details);
  expect(detailText).toContain("calories");
  expect(detailText).toContain("\\\"details_pending\\\":false");
  expect(detailText).toContain("pace_sec_per_km");
  expect(detailText).not.toContain("startLatitude");
  expect(detailText).not.toContain("heartRate");
  const chart = await decode(await handleMcp(request(5, "tools/call", { name: "run_chart", arguments: { id: "321" } }), env, ctx));
  expect(JSON.stringify(chart)).toContain("heartRate");
});
