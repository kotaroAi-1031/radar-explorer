// Pure logic for the radar explorer: title tokenisation, deterministic
// clustering, the neurons guard, trigger decisions and the verification
// gate. Everything in this module is side-effect free and unit-tested
// (see logic.test.ts / views.test.ts).

// ---------------------------------------------------------------------------
// GDELT seendate helpers ("20260815T120000Z")
// ---------------------------------------------------------------------------

export function seendateToDate(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

export function dateToSeendate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

// ---------------------------------------------------------------------------
// Neurons accounting (Workers AI)
// ---------------------------------------------------------------------------

// Model policy (user decision, 2026-11-07): the balanced Llama 4 Scout
// 17B MoE is the main model for chat, tool choice and view generation.
// The 70B model is not used. The 8B fp8-fast remains only as the neurons
// guard's fallback and for the lightest routing work.
export const MODEL_MAIN = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const MODEL_FAST = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
// Chat goes through createAI (the agents SDK gateway provider). Scout
// returns empty completions on that path (measured 2026-11-07), while the
// direct env.AI.run path used for view generation works fine with it.
// Chat therefore uses Mistral Small 3.1, the sanctioned fallback candidate.
export const MODEL_CHAT = "@cf/mistralai/mistral-small-3.1-24b-instruct";

// Neuron pricing per 1M tokens. Workers AI charges $0.000011 per neuron,
// so neurons = USD price / 0.000011. Official unit pricing (model pages,
// checked 2026-11-07): Scout $0.27 in / $0.85 out -> 24,545 / 77,273;
// 8B fp8-fast 4,119 in / 34,868 out (design-document pricing table).
const NEURON_RATES: Record<string, { in: number; out: number }> = {
  [MODEL_MAIN]: { in: 24545, out: 77273 },
  [MODEL_FAST]: { in: 4119, out: 34868 },
  // $0.351 / $0.555 per M tokens (model page, checked 2026-11-07).
  [MODEL_CHAT]: { in: 31909, out: 50455 },
};

export function estimateNeurons(model: string, inputTokens: number, outputTokens: number): number {
  const r = NEURON_RATES[model] ?? NEURON_RATES[MODEL_MAIN];
  return (inputTokens * r.in + outputTokens * r.out) / 1_000_000;
}

/** Daily guard: at 6,000 neurons stop generating with the main model and
 *  fall back to the 8B fast model; at 8,000 stop automatic generation
 *  entirely. The free tier ceiling is 10,000/day, so both thresholds keep
 *  headroom. */
export function pickModelForUsage(usedToday: number): string | null {
  if (usedToday >= 8000) return null;
  if (usedToday >= 6000) return MODEL_FAST;
  return MODEL_MAIN;
}

// ---------------------------------------------------------------------------
// Diff trigger
// ---------------------------------------------------------------------------

export const NEW_ARTICLE_THRESHOLD = 10;

/** A radar check generates views when enough new articles arrived OR the
 *  pool frontier advanced (a gap started closing). */
export function shouldTrigger(newCount: number, frontierAdvanced: boolean): boolean {
  return newCount > 0 && (newCount >= NEW_ARTICLE_THRESHOLD || frontierAdvanced);
}

// ---------------------------------------------------------------------------
// Deterministic clustering: normalised title token overlap
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "as",
  "at",
  "by",
  "with",
  "from",
  "after",
  "over",
  "amid",
  "says",
  "say",
  "new",
  "news",
  "report",
  "reports",
  "update",
  "live",
  "video",
  "watch",
]);

export function titleTokens(title: string): Set<string> {
  const norm = title
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, " ");
  const tokens = new Set<string>();
  for (const w of norm.split(/\s+/)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) tokens.add(w);
  }
  return tokens;
}

export interface ClusterableArticle {
  url: string;
  title: string | null;
}

export interface Cluster<T extends ClusterableArticle> {
  key: string;
  articles: T[];
  tokens: Set<string>;
}

export function clusterArticles<T extends ClusterableArticle>(articles: T[]): Cluster<T>[] {
  const clusters: Cluster<T>[] = [];
  for (const a of articles) {
    if (!a.title) continue;
    const tokens = titleTokens(a.title);
    if (tokens.size === 0) continue;
    let best: Cluster<T> | null = null;
    let bestScore = 0;
    for (const c of clusters) {
      let inter = 0;
      for (const t of tokens) if (c.tokens.has(t)) inter++;
      const score = inter / Math.min(tokens.size, c.tokens.size);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best && bestScore >= 0.6) {
      best.articles.push(a);
      for (const t of tokens) best.tokens.add(t);
    } else {
      const key = [...tokens].slice(0, 6).sort().join(" ");
      clusters.push({ key, articles: [a], tokens });
    }
  }
  return clusters.sort((x, y) => y.articles.length - x.articles.length);
}

// ---------------------------------------------------------------------------
// Verification gate helpers
// ---------------------------------------------------------------------------

export function extractNumbers(text: string): string[] {
  return [...text.matchAll(/\d[\d,.]*\d|\d/g)].map((m) => m[0]);
}

export function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)"'<>]+/g)].map((m) => m[0]);
}

/** Numbers that may legitimately appear in generated prose: every number
 *  in the input titles/seendates, plus the cluster size itself. */
export function allowedNumbersFor(
  articles: { title: string | null; seendate: string | null }[],
): Set<string> {
  const allowed = new Set<string>();
  for (const a of articles) {
    for (const n of extractNumbers(`${a.title ?? ""} ${a.seendate ?? ""}`)) {
      allowed.add(n);
    }
  }
  allowed.add(String(articles.length));
  return allowed;
}
