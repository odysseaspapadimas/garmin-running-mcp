import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { getRun, listRuns, parseDate, publicRun, syncStatus, type Env, type Run } from "./storage.js";
import { safeLaps } from "./laps.js";
import { safeSplitSummaries } from "./split-summaries.js";
import { safeChart, safeDetail } from "./detail.js";
import { compareRuns } from "./compare.js";
import { refreshLatestRun } from "./refresh.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().regex(/^\d{1,20}$/);
const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export function createServer(env: Env) {
  const server = new McpServer({ name: "garmin-running", version: "0.1.0" });
  server.registerTool("training_context", { description: "User's running goal. Compare training suggestions against cached running and recovery data; do not assume unavailable metrics are healthy.", inputSchema: {}, annotations: ro }, async () => output({ current_goal: "5 km in under 30 minutes", target_pace_sec_per_km: 360, later_goal: "build toward 10 km", guidance: "Use recent volume, intensity and recovery trends; propose plan changes for the runner to approve, never write to Garmin." }));
  server.registerTool("sync_status", { description: "Last scheduled Garmin sync, manual refresh status, error category and historical backfill progress. Except for an explicit refresh_latest_run call, all tools use cached data.", inputSchema: {}, annotations: ro }, async () => output(await syncStatus(env.DB)));
  server.registerTool("latest_run", { description: "Most recently cached running activity, with pace in seconds per kilometer. Null metrics mean unavailable. Use refresh_latest_run to check Garmin after a new run.", inputSchema: {}, annotations: ro }, async () => {
    const run = await env.DB.prepare("SELECT * FROM runs ORDER BY start_utc DESC LIMIT 1").first<Run>();
    return output(run ? publicRun(run) : null);
  });
  server.registerTool("refresh_latest_run", { description: "Explicitly check Garmin for the newest run and cache its summary plus per-lap splits when available. At most one activity-list request and one spaced split request per minute; no history backfill, FIT, GPS chart or Garmin writes. Returns busy/cooldown if another sync is running or Garmin was checked recently. Garmin may still be processing laps; scheduled sync fills chart, HR zones and originals later.", inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } }, async () => output(await refreshLatestRun(env)));
  server.registerTool("list_runs", { description: "Runs in inclusive LOCAL Garmin calendar dates; at most 100, newest first. No Garmin request.", inputSchema: { start: date, end: date, limit: z.number().int().min(1).max(100).default(50) }, annotations: ro }, async ({ start, end, limit }) => output(await listRuns(env.DB, start, end, limit)));
  server.registerTool("run_details", { description: "Cached summary and per-lap splits: use laps for km-by-km pacing even if full_details_pending is true. details_pending means laps are unavailable; full_details_pending means charts and other details await scheduled sync. No raw GPS tracks or FIT.", inputSchema: { id }, annotations: ro }, async ({ id: runId }) => {
    const run = await getRun(env.DB, runId);
    if (!run) return output({ error: "Run not found in cache" });
    return output({ ...publicRun(run), details_pending: !run.raw_laps, full_details_pending: !run.raw_detail, ...safeDetail(run.raw_summary), laps: safeLaps(run.raw_laps ? JSON.parse(run.raw_laps) : null), split_group_summaries: run.raw_splits ? safeSplitSummaries(JSON.parse(run.raw_splits)) : null, hr_time_in_zones: run.raw_hr_zones ? JSON.parse(run.raw_hr_zones) : null });
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
  server.registerTool("recovery", { description: "Available Garmin daily readiness, HRV and daily summary; missing metrics are not zero.", inputSchema: { date }, annotations: ro }, async ({ date: day }) => {
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
