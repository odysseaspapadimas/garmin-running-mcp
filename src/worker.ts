import { assertAccess } from "./access.js";
import { syncOnce } from "./garmin.js";
import { handleMcp } from "./mcp.js";
import type { Env } from "./storage.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
    try {
      await assertAccess(request, env);
    } catch {
      return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    return handleMcp(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncOnce(env));
  },
} satisfies ExportedHandler<Env>;
