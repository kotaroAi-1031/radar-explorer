import { getAgentByName, routeAgentRequest } from "agents";
import type { Env } from "./env";
import { mcpHandler } from "./mcp";
import { neuronsUsedToday } from "./generate";
import { poolStatus } from "./radar";

export { ExplorerAgent } from "./agent";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcpHandler(env)(request, env, ctx);
    }

    if (url.pathname.startsWith("/agents/")) {
      const routed = await routeAgentRequest(request, env);
      if (routed) return routed;
      return json({ error: "agent route not found" }, 404);
    }

    if (url.pathname === "/api/status") {
      const [questions, neurons] = await Promise.all([poolStatus(env), neuronsUsedToday(env)]);
      return json({ questions, neuronsUsedToday: neurons });
    }

    if (url.pathname === "/api/views") {
      const rs = await env.DB.prepare(
        "SELECT id, question_id, title, spec, article_count, verified, warnings, origin, created_at FROM generated_views ORDER BY id DESC LIMIT 20",
      ).all();
      const views = rs.results.map((r) => ({
        id: r.id,
        question_id: r.question_id,
        title: r.title,
        spec: JSON.parse(String(r.spec)),
        article_count: r.article_count,
        verified: r.verified,
        warnings: r.warnings,
        origin: r.origin,
        created_at: r.created_at,
      }));
      return json({ views });
    }

    if (url.pathname === "/api/check-now" && request.method === "POST") {
      const stub = await getAgentByName(env.EXPLORER_AGENT, "main");
      const summary = await stub.runRadarCheck();
      return json(summary);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const stub = await getAgentByName(env.EXPLORER_AGENT, "main");
    ctx.waitUntil(
      stub
        .runRadarCheck()
        .then((s) => {
          console.log(`radar check: views=${s.newViews} neuronsToday=${s.neuronsUsedToday}`);
        })
        .catch((err) => {
          console.error("radar check failed", err);
        }),
    );
  },
} satisfies ExportedHandler<Env>;
