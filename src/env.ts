import type { ExplorerAgent } from "./agent";

export interface Env {
  AI: Ai;
  DB: D1Database;
  EXPLORER: DurableObjectNamespace<ExplorerAgent>;
  /** JSON map: { q1..q6: { url, authToken } } — same secret the collector uses. */
  TURSO_DATABASES_JSON: string;
  ASSETS: Fetcher;
}
