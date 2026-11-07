import type { Env } from "./env";
import {
  QUESTION_IDS,
  QUESTION_LABELS,
  newArticlesSince,
  poolStatus,
  type Article,
  type QuestionId,
} from "./radar";
import { BASELINES } from "./content.generated";

export const MODEL_MAIN = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const MODEL_FAST = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";

// Workers AI neuron pricing (per 1M tokens), from the pricing table the
// design document verified: 70B fp8-fast 26,668 in / 204,805 out;
// 8B fp8-fast 4,119 in / 34,868 out.
const NEURON_RATES: Record<string, { in: number; out: number }> = {
  [MODEL_MAIN]: { in: 26668, out: 204805 },
  [MODEL_FAST]: { in: 4119, out: 34868 },
};

export function estimateNeurons(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const r = NEURON_RATES[model] ?? NEURON_RATES[MODEL_MAIN];
  return (inputTokens * r.in + outputTokens * r.out) / 1_000_000;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function neuronsUsedToday(env: Env): Promise<number> {
  const rs = await env.DB.prepare("SELECT neurons FROM neurons WHERE day =?")
    .bind(todayUtc())
    .first<{ neurons: number }>();
  return rs?.neurons ?? 0;
}

export async function recordNeurons(env: Env, neurons: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO neurons (day, neurons, calls) VALUES (?,?, 1) " +
      "ON CONFLICT(day) DO UPDATE SET neurons = neurons + excluded.neurons, calls = calls + 1",
  )
    .bind(todayUtc(), neurons)
    .run();
}

/** Daily guard: at 6,000 stop drafting with the 70B model (fall back to
 * 8B); at 8,000 stop automatic generation entirely. */
export async function pickModel(env: Env): Promise<string | null> {
  const used = await neuronsUsedToday(env);
  if (used >= 8000) return null;
  if (used >= 6000) return MODEL_FAST;
  return MODEL_MAIN;
}

// ---------------------------------------------------------------------------
// Deterministic clustering: normalise titles, compare significant-token sets.
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

export interface Cluster {
  key: string;
  articles: (Article & { fetchedAt: string })[];
  tokens: Set<string>;
}

export function clusterArticles(
  articles: (Article & { fetchedAt: string })[],
): Cluster[] {
  const clusters: Cluster[] = [];
  for (const a of articles) {
    if (!a.title) continue;
    const tokens = titleTokens(a.title);
    if (tokens.size === 0) continue;
    let best: Cluster | null = null;
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
// Drafting (70B, JSON) + verification gate
// ---------------------------------------------------------------------------

interface DraftBody {
  headline: string;
  what: string;
  sources: string[];
  impact: string;
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    what: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
    impact: { type: "string" },
  },
  required: ["headline", "what", "sources", "impact"],
  additionalProperties: false,
} as const;

async function draftCluster(
  env: Env,
  model: string,
  qid: QuestionId,
  cluster: Cluster,
): Promise<{ body: DraftBody; neurons: number }> {
  const baseline = (BASELINES[qid] ?? "").slice(0, 3000);
  const lines = cluster.articles
    .slice(0, 15)
    .map(
      (a) =>
        `- [${a.domain ?? "?"} / ${a.seendate ?? "?"}] ${a.title ?? ""} (${a.url})`,
    )
    .join("\n");
  const prompt =
    `あなたは「一次情報レーダー」の記録担当です。以下の記事群は同じ出来事を報じたものとして機械的にまとめられました。\n` +
    `この出来事について、スレッド記録の形式で下書きを1件だけ作ってください。\n\n` +
    `形式（JSON）:\n` +
    `- headline: 出来事の見出し（日本語、1行）\n` +
    `- what: 何が起きたか（日本語、記事群から読み取れる事実のみ。記事に無い数値・固有名詞を発明しない）\n` +
    `- sources: 出典URLの配列（下の記事のURLから最大3件、そのままコピーする）\n` +
    `- impact: 見立てへの影響（下記の現時点の見立てに照らして、この出来事が何を意味するか。判断できない場合は「現時点では見立てに影響なし」と書く）\n\n` +
    `\n${baseline}\n\n` +
    `\n${lines}\n`;
  const res = (await env.AI.run(model, {
    messages: [
      {
        role: "system",
        content:
          "出力は指定されたJSONスキーマに従うJSONのみ。前置きやコードフェンスは付けない。",
      },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_schema", json_schema: DRAFT_SCHEMA },
    max_tokens: 900,
  })) as {
    response?: unknown;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const neurons = estimateNeurons(
    model,
    res.usage?.prompt_tokens ?? 0,
    res.usage?.completion_tokens ?? 0,
  );
  await recordNeurons(env, neurons);
  let parsed: unknown = res.response;
  if (typeof parsed === "string") {
    parsed = JSON.parse(parsed.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  }
  const body = parsed as DraftBody;
  if (
    typeof body?.headline !== "string" ||
    typeof body?.what !== "string" ||
    !Array.isArray(body?.sources) ||
    typeof body?.impact !== "string"
  ) {
    throw new Error("draft JSON did not match the expected shape");
  }
  return { body, neurons };
}

/** Verification gate: every cited source URL must exist in the input set,
 * and every number in the draft text must appear in an input title (or be
 * the cluster's own article count / a year in a seendate). Failures do not
 * discard the draft; they attach warnings and verified=0. */
function verifyDraft(body: DraftBody, cluster: Cluster): string[] {
  const warnings: string[] = [];
  const urlSet = new Set(cluster.articles.map((a) => a.url));
  for (const s of body.sources) {
    if (!urlSet.has(s)) warnings.push(`出典URLが入力集合に存在しない: ${s}`);
  }
  if (body.sources.length === 0) warnings.push("出典が空");
  const haystack = cluster.articles
    .map((a) => `${a.title ?? ""} ${a.seendate ?? ""}`)
    .join(" ");
  const allowed = new Set<string>();
  for (const m of haystack.matchAll(/\d[\d,.]*\d|\d/g)) allowed.add(m[0]);
  allowed.add(String(cluster.articles.length));
  const text = `${body.headline} ${body.what} ${body.impact}`;
  for (const m of text.matchAll(/\d[\d,.]*\d|\d/g)) {
    if (!allowed.has(m[0])) {
      warnings.push(`入力に現れない数値: ${m[0]}`);
      break; // one example is enough to flag the draft
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// The radar check itself (cron + manual trigger share this path)
// ---------------------------------------------------------------------------

export interface RadarCheckSummary {
  checkedAt: string;
  model: string | null;
  neuronsUsedToday: number;
  newDrafts: number;
  draftIds: number[];
  perQuestion: {
    questionId: QuestionId;
    newArticles: number;
    frontierAdvanced: boolean;
    drafts: number;
    skipped?: string;
  }[];
}

const NEW_ARTICLE_THRESHOLD = 10;
const MAX_DRAFTS_PER_QUESTION = 3;
const MIN_CLUSTER_SIZE = 2;

export async function runRadarCheck(env: Env): Promise<RadarCheckSummary> {
  const checkedAt = new Date().toISOString();
  const status = await poolStatus(env);
  const frontierByQ = new Map(status.map((s) => [s.questionId, s.frontier]));
  const summary: RadarCheckSummary = {
    checkedAt,
    model: null,
    neuronsUsedToday: await neuronsUsedToday(env),
    newDrafts: 0,
    draftIds: [],
    perQuestion: [],
  };

  for (const qid of QUESTION_IDS) {
    const state = await env.DB.prepare(
      "SELECT last_check_at, frontier FROM state WHERE question_id =?",
    )
      .bind(qid)
      .first<{ last_check_at: string | null; frontier: string | null }>();
    const frontier = frontierByQ.get(qid) ?? null;
    const frontierAdvanced =
      frontier !== null &&
      (state?.frontier == null || frontier > state.frontier);
    // First ever check: only look back 24h so the standing backfill does
    // not produce an unbounded flood; afterwards, everything since the
    // last check.
    const since =
      state?.last_check_at ??
      new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const fresh = await newArticlesSince(env, qid, since);
    const entry: RadarCheckSummary["perQuestion"][number] = {
      questionId: qid,
      newArticles: fresh.length,
      frontierAdvanced,
      drafts: 0,
    };
    summary.perQuestion.push(entry);

    const triggered = fresh.length >= NEW_ARTICLE_THRESHOLD || frontierAdvanced;
    if (triggered && fresh.length > 0) {
      const model = await pickModel(env);
      summary.model = model;
      if (!model) {
        entry.skipped = "neurons guard: daily budget exhausted";
      } else {
        const clusters = clusterArticles(fresh).filter(
          (c) => c.articles.length >= MIN_CLUSTER_SIZE,
        );
        for (const cluster of clusters.slice(0, MAX_DRAFTS_PER_QUESTION)) {
          try {
            const { body } = await draftCluster(env, model, qid, cluster);
            const warnings = verifyDraft(body, cluster);
            const info = await env.DB.prepare(
              "INSERT INTO drafts (question_id, cluster_key, headline, body, article_count, verified, warnings, status, model, created_at) " +
                "VALUES (?,?,?,?,?,?,?, 'pending',?,?)",
            )
              .bind(
                qid,
                cluster.key,
                body.headline,
                JSON.stringify(body),
                cluster.articles.length,
                warnings.length === 0 ? 1 : 0,
                JSON.stringify(warnings),
                model,
                checkedAt,
              )
              .run();
            entry.drafts++;
            summary.newDrafts++;
            if (info.meta.last_row_id) {
              summary.draftIds.push(Number(info.meta.last_row_id));
            }
          } catch (err) {
            entry.skipped = `draft failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }

    await env.DB.prepare(
      "INSERT INTO state (question_id, last_check_at, frontier, total) VALUES (?,?,?,?) " +
        "ON CONFLICT(question_id) DO UPDATE SET last_check_at = excluded.last_check_at, frontier = excluded.frontier, total = excluded.total",
    )
      .bind(
        qid,
        checkedAt,
        frontier,
        status.find((s) => s.questionId === qid)?.total ?? 0,
      )
      .run();
  }

  summary.neuronsUsedToday = await neuronsUsedToday(env);
  return summary;
}
