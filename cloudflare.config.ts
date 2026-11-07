import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Single Worker: static assets (React SPA) + the ExplorerAgent Durable
// Object + the stateless MCP endpoint + an hourly cron that watches the
// collector databases for new arrivals and generates event views.
// Storage: the radar data itself lives in Turso (read-only here); this
// Worker's own D1 holds generated views, chat-thread index rows,
// diff-detection state and the neurons counter. See README.md.
const worker = defineWorker({
  name: "radar-explorer",
  compatibilityDate: "2026-10-15",
  entrypoint,
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/agents/*", "/mcp", "/mcp/*", "/api/*"],
  },
  triggers: [triggers.scheduled({ schedule: "0 * * * *" })],
  env: {
    AI: bindings.ai(),
    DB: bindings.d1({ name: "radar-explorer" }),
    EXPLORER_AGENT: bindings.durableObject({
      worker: "radar-explorer",
      exportName: "ExplorerAgent",
    }),
    TURSO_DATABASES_JSON: bindings.secret(),
    ASSETS: bindings.assets(),
  },
  exports: {
    ExplorerAgent: exports.durableObject({ storage: "sqlite" }),
  },
});

export default defineConfig({ worker });
