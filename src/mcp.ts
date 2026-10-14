import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { getRun, listRuns, parseDate, publicRun, syncStatus, type Env, type Run } from "./storage.js";
import { safeChart } from "./detail.js";
import { runReport } from "./run-report.js";
import { compareRuns } from "./compare.js";
import { refreshLatestRun } from "./refresh.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().regex(/^\d{1,20}$/);
const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export function createServer(env: Env) {
  const server = new McpServer({ name: "garmin-running", version: "0.1.0" });
  server.registerTool("training_context", { description: "User's running goal. Compare training suggestions against cached running and recovery data; do not assume unavailable metrics are healthy.", inputSchema: {}, annotations: ro }, async () => output({ current_goal: "5 km in under 30 minutes", target_pace_sec_per_km: 360, later_goal: "build toward 10 km", guidance: "Use recent volume, intensity and recovery trends; propose plan changes for the runner to approve, never write to Garmin." }));
  server.registerTool("sync_status", { description: "On-demand refresh status and error category, plus legacy sync/backfill checkpoints. No scheduled sync runs. Except for an explicit refresh_latest_run call, all tools use cached data.", inputSchema: {}, annotations: ro }, async () => output({ ...(await syncStatus(env.DB)), sync_mode: "on_demand", scheduled_sync_enabled: false }));
  server.registerTool("latest_run", { description: "Most recently cached running activity, with pace in seconds per kilometer. Null metrics mean unavailable. Use refresh_latest_run to check Garmin after a new run.", inputSchema: {}, annotations: ro }, async () => {
    const run = await env.DB.prepare("SELECT * FROM runs ORDER BY start_utc DESC LIMIT 1").first<Run>();
    return output(run ? publicRun(run) : null);
  });
  server.registerTool("refresh_latest_run", { description: "Explicit post-run sync: check up to five recent activities and cache the newest run summary, laps, Garmin HR time in zones and up to 500 chart samples. Returns safe summary, laps, zone seconds and per-section availability; use run_chart for opt-in non-GPS samples. Missing sections are retried even for an unchanged run. One-minute cooldown, single-flight lease and five-second spacing between detail requests; no polling, history, recovery, originals or Garmin writes. No scheduled sync. Garmin may still be processing data; not_fetched is not the same as unavailable.", inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, async () => output(await refreshLatestRun(env)));
  server.registerTool("list_runs", { description: "Runs in inclusive LOCAL Garmin calendar dates; at most 100, newest first. No Garmin request.", inputSchema: { start: date, end: date, limit: z.number().int().min(1).max(100).default(50) }, annotations: ro }, async ({ start, end, limit }) => output(await listRuns(env.DB, start, end, limit)));
  server.registerTool("run_details", { description: "Cached summary, laps and actual Garmin HR-zone seconds with per-section data_status. Use laps for kilometer pacing, not time-in-zone estimates. not_fetched means no request yet; unavailable means no data returned on the last fetch, not permanently absent. refresh_latest_run retries missing detail for the newest run; no scheduled sync. No raw GPS tracks or FIT.", inputSchema: { id }, annotations: ro }, async ({ id: runId }) => {
    const run = await getRun(env.DB, runId);
    if (!run) return output({ error: "Run not found in cache" });
    return output(runReport(run));
  });
  server.registerTool("run_chart", { description: "Opt-in cached per-sample running metrics (no GPS coordinates). Paginated; only the first 500 Garmin samples are cached; at most 100 returned per call.", inputSchema: { id, offset: z.number().int().min(0).max(499).default(0), limit: z.number().int().min(1).max(100).default(50) }, annotations: ro }, async ({ id: runId, offset, limit }) => {
    const run = await getRun(env.DB, runId);
    if (!run) return output({ error: "Run not found in cache" });
    return output({ id: runId, ...safeChart(run.raw_detail, offset, limit) });
  });
  server.registerTool("compare_runs", { description: "Compare up to ten cached runs. Deltas are newest minus each older run; negative pace means faster. Different distances/intensities can limit comparability; no clinical conclusions.", inputSchema: { ids: z.array(id).min(2).max(10) }, annotations: ro }, async ({ ids }) => {
    const rows = await Promise.all(ids.map((runId) => getRun(env.DB, runId)));
    return output({ ...compareRuns(rows.filter((run): run is Run => run != null)), missing_ids: ids.filter((_, i) => !rows[i]) });
  });
  server.registerTool("running_trends", { description: "Weekly running volume, average moving pace and average heart rate from cached runs over at most 365 days. Do not interpret as medical advice.", inputSchema: { days: z.number().int().min(7).max(365).default(56) }, annotations: ro }, async ({ days }) => {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = await env.DB.prepare(`SELECT strftime('%Y-%W', start_utc) AS week, COUNT(*) AS runs, ROUND(SUM(distance_m)/1000.0, 2) AS km,
      ROUND(SUM(moving_s)*1000.0/NULLIF(SUM(distance_m),0), 1) AS pace_sec_per_km,
      ROUND(AVG(avg_hr_bpm), 1) AS avg_hr_bpm
      FROM runs WHERE start_utc >= ? GROUP BY week ORDER BY week DESC LIMIT 54`).bind(since).all();
    return output(rows.results);
  });
  server.registerTool("recovery", { description: "Previously cached Garmin daily readiness, HRV and daily summary, with timestamps. On-demand run refresh does not update recovery metrics; no scheduled sync. Data may be stale and missing metrics are not zero.", inputSchema: { date }, annotations: ro }, async ({ date: day }) => {
    parseDate(day);
    const rows = await env.DB.prepare("SELECT kind, raw_json, updated_at FROM daily_metrics WHERE date = ? ORDER BY kind").bind(day).all<{kind: string; raw_json: string; updated_at: string}>();
    return output(Object.fromEntries(rows.results.map((row) => [row.kind, { value: JSON.parse(row.raw_json), updated_at: row.updated_at }])));
  });
  return server;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext) {
  return createMcpHandler(() => createServer(env), {
    route: "/mcp", corsOptions: false, responseMode: "json",
    allowedOriginHostnames: ["chatgpt.com", "chat.openai.com", "localhost"],
  })(request, env, ctx);
}
