// Event-driven view generation.
//
// Every hour (cron) — and on demand via /api/check-now — this module
// diffs the collector pools against the per-question state kept in D1.
// When a question gained enough new articles or its frontier advanced,
// the new articles are clustered deterministically; each flagged cluster
// becomes a generated view (Generative UI spec, see views.ts): the model
// picks the layout and writes the prose, code fills in all data, the
// verification gate checks the result, and the spec is stored in D1's
// generated_views table. The agent broadcasts the arrival so connected
// screens can render the new view immediately.
//
// The daily neurons guard keeps the free tier safe: at 6,000 neurons the
// generator falls back from the main model (Llama 4 Scout) to the 8B fast one, and at 8,000 it
// stops generating for the day.

import type { Env } from "./env";
import {
  MODEL_CHAT,
  MODEL_FAST,
  MODEL_MAIN,
  clusterArticles,
  estimateNeurons,
  pickModelForUsage,
  rankEvents,
  shouldTrigger,
  type Cluster,
  type RankedEventCandidate,
} from "./logic";
import {
  QUESTION_IDS,
  QUESTION_LABELS,
  newArticlesSince,
  poolStatus,
  recentArticles,
  toneTrend,
  type PoolStatusEntry,
  type QuestionId,
} from "./radar";
import type { Article } from "./radar-types";
import { BASELINES } from "./content.generated";
import {
  VIEW_SECTION_TYPES,
  fallbackChoice,
  isDuplicateWarning,
  materializeViewSpec,
  ruleBasedChoice,
  verifyViewSpec,
  viewChoiceProblems,
  type ChoiceSource,
  type ViewChoice,
  type ViewSpec,
} from "./views";

export type { ChoiceSource };

export { MODEL_CHAT, MODEL_FAST, MODEL_MAIN, estimateNeurons };

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

async function pickModel(env: Env): Promise<string | null> {
  return pickModelForUsage(await neuronsUsedToday(env));
}

// ---------------------------------------------------------------------------
// Model call: choose a layout + write prose for one cluster
// ---------------------------------------------------------------------------

const VIEW_CHOICE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    impact: { type: "string" },
    sections: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: VIEW_SECTION_TYPES },
          heading: { type: "string" },
        },
        required: ["type", "heading"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "summary", "impact", "sections"],
  additionalProperties: false,
} as const;

// The catalog is listed by purpose, in an order deliberately unrelated
// to any layout: an earlier version listed the parts in the fallback's
// fixed order (with summary/assessment marked mandatory and pinned to
// the head/tail), which anchored the model into emitting that same
// order for every event.
const SECTION_GUIDE =
  "部品カタログ（sections に type と heading を並べる。並べた順序がそのまま画面の並びになる）:\n" +
  "- article_cards: 記事カード列（出典リンク付き）。出来事そのものを見せたいときに\n" +
  "- source_list: 報じた媒体の一覧と件数。報道の広がりが要点のときに\n" +
  "- timeline: 記事の時系列。出来事の推移が要点のときに\n" +
  "- tone_chart: その問いの日別件数と平均トーンのグラフ\n" +
  "- stat_row: プールの数字（累計・最先端・直近24h・この出来事の件数）\n" +
  "- summary: 出来事の要約（文章）\n" +
  "- assessment: 見立てパネル（現時点の見立て抜粋＋見立てへの影響）";

interface AiRunResult {
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function chooseViewLayout(
  env: Env,
  model: string,
  qid: QuestionId,
  cluster: Cluster<Article & { fetchedAt: string }>,
): Promise<{ choice: ViewChoice; neurons: number }> {
  const baseline = (BASELINES[qid] ?? "").slice(0, 2500);
  const lines = cluster.articles
    .slice(0, 15)
    .map((a) => `- [${a.domain ?? "?"} / ${a.seendate ?? "?"}] ${a.title ?? ""} (${a.url})`)
    .join("\n");
  const prompt =
    `あなたは「一次情報レーダー探検UI」の画面生成担当です。以下の記事群は同じ出来事を報じたものとして機械的にまとめられました。\n` +
    `この出来事専用の画面（ダッシュボード）を設計してください。あなたが決めるのは部品の選択と並び順、そして文章だけです。数値データや記事データはシステムが部品に流し込みます。\n\n` +
    `${SECTION_GUIDE}\n\n` +
    `出力（JSON）:\n` +
    `- title: 画面のタイトル（日本語、この出来事固有の見出し。問いの名前や見立て文の使い回しは禁止）\n` +
    `- summary: 何が起きたか（日本語、記事群から読み取れる事実のみ。記事に無い数値・固有名詞を発明しない。見立ての文章を書き写さず、この出来事について書くこと）\n` +
    `- impact: 見立てへの影響（下記の見立てに照らした、この出来事固有の意味。判断できなければ空文字列にする。定型文は書かない）\n` +
    `- sections: 部品の並び（3〜6個）。順序はこの出来事の要点に合った順序を自由に決めること（先頭・末尾の固定はない）。各部品には、この出来事に即した具体的な見出し（heading）を必ず付けること\n\n` +
    `\n${baseline}\n\n` +
    `\n${lines}\n`;
  const res = (await env.AI.run(model, {
    messages: [
      {
        role: "system",
        content:
          "出力は指定されたJSONスキーマに従うJSONのみ。前置きやコードフェンスは付けない。HTMLは絶対に書かない。",
      },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_schema", json_schema: VIEW_CHOICE_SCHEMA },
    max_tokens: 1000,
  })) as AiRunResult;
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
  const choice = parsed as ViewChoice;
  if (
    typeof choice?.title !== "string" ||
    typeof choice?.summary !== "string" ||
    typeof choice?.impact !== "string" ||
    !Array.isArray(choice?.sections) ||
    choice.sections.some(
      (s) => !s || typeof s.type !== "string" || !VIEW_SECTION_TYPES.includes(s.type),
    )
  ) {
    throw new Error("view choice JSON did not match the expected shape");
  }
  const problems = viewChoiceProblems(choice);
  if (problems.length > 0) {
    throw new Error(`view choice rejected: ${problems.join("; ")}`);
  }
  return { choice, neurons };
}

// ---------------------------------------------------------------------------
// View assembly for one cluster (shared by cron generation)
// ---------------------------------------------------------------------------

/** Title + summary of the most recent views for a question, used by the
 *  gate's duplicate checks. Reading failures degrade to "no history"
 *  rather than blocking generation. */
export async function recentViewProse(
  env: Env,
  qid: QuestionId,
  limit = 20,
): Promise<{ title: string; summary: string }[]> {
  try {
    const rs = await env.DB.prepare(
      "SELECT title, spec FROM generated_views WHERE question_id = ? ORDER BY id DESC LIMIT ?",
    )
      .bind(qid, limit)
      .all();
    return rs.results.map((r) => {
      let summary = "";
      try {
        const spec = JSON.parse(String(r.spec)) as ViewSpec;
        summary = spec.sections.find((s) => s.type === "summary")?.text ?? "";
      } catch {
        summary = "";
      }
      return { title: String(r.title), summary };
    });
  } catch {
    return [];
  }
}

export async function generateViewForCluster(
  env: Env,
  model: string,
  qid: QuestionId,
  cluster: Cluster<Article & { fetchedAt: string }>,
  pool: PoolStatusEntry,
  origin: "cron" | "chat",
): Promise<{
  spec: ViewSpec;
  warnings: string[];
  choiceSource: ChoiceSource;
  model: string | null;
}> {
  const [trend, existingProse] = await Promise.all([
    toneTrend(env, qid, 30).catch(() => []),
    recentViewProse(env, qid),
  ]);
  const assemble = (choice: ViewChoice): { spec: ViewSpec; warnings: string[] } => {
    const spec = materializeViewSpec({
      questionId: qid,
      generatedAt: new Date().toISOString(),
      origin,
      cluster,
      choice,
      trend,
      pool: {
        total: pool.total,
        frontier: pool.frontier,
        recent24h: pool.recent24h,
      },
      baseline: BASELINES[qid] ?? "",
    });
    const warnings = verifyViewSpec(spec, {
      articleUrls: new Set(cluster.articles.map((a) => a.url)),
      articles: cluster.articles,
      baseline: BASELINES[qid] ?? "",
      existingProse,
    });
    return { spec, warnings };
  };

  let choiceSource: ChoiceSource = "model";
  let usedModel: string | null = model;
  let result: { spec: ViewSpec; warnings: string[] } | null = null;
  // One regeneration attempt when the gate flags recycled prose: the
  // audited failure mode was the model copying the baseline (or a
  // previous view's title) instead of writing about this event.
  for (let attempt = 0; attempt < 2 && result === null; attempt++) {
    try {
      const { choice } = await chooseViewLayout(env, model, qid, cluster);
      const built = assemble(choice);
      if (!built.warnings.some(isDuplicateWarning) || attempt === 1) {
        result = built;
      }
    } catch {
      break;
    }
  }
  if (result === null || result.warnings.some(isDuplicateWarning)) {
    // Model unusable, or its prose stayed recycled after a retry: fall
    // back to the deterministic choice (its title is this event's top
    // headline) and record that honestly as a fallback.
    result = assemble(fallbackChoice(cluster, QUESTION_LABELS[qid]));
    choiceSource = "fallback";
    usedModel = null;
  }
  return { ...result, choiceSource, model: usedModel };
}

export async function saveView(
  env: Env,
  qid: QuestionId,
  clusterKey: string,
  spec: ViewSpec,
  articleCount: number,
  warnings: string[],
  model: string | null,
  choiceSource: ChoiceSource,
): Promise<number> {
  const info = await env.DB.prepare(
    "INSERT INTO generated_views (question_id, cluster_key, title, spec, article_count, verified, warnings, model, origin, created_at, choice_source) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      qid,
      clusterKey,
      spec.title,
      JSON.stringify(spec),
      articleCount,
      warnings.length === 0 ? 1 : 0,
      JSON.stringify(warnings),
      model,
      spec.origin,
      spec.generatedAt,
      choiceSource,
    )
    .run();
  return Number(info.meta.last_row_id ?? 0);
}

// ---------------------------------------------------------------------------
// Attention ranking: "what is the world paying attention to"
// ---------------------------------------------------------------------------

/** The recent window every event-clustering call shares, so a cluster key
 *  produced by hotEvents resolves to the same cluster in buildEventView. */
export const HOT_WINDOW = 150;
const HOT_MIN_CLUSTER = 2;
const HOT_TOP_N = 12;

export interface HotEvent extends RankedEventCandidate {
  questionLabel: string;
}

export interface HotEventsResult {
  events: HotEvent[];
  /** Newest frontier across all pools (ISO string): the honest "as of"
   *  of the ranking. The pool is backfilling, so this can lag real time
   *  by a lot — callers must show it rather than imply "right now". */
  poolLatest: string | null;
  generatedAt: string;
}

/** Ranked events across all six questions. The order comes from
 *  rankEvents (deterministic: coverage volume, then outlet breadth, then
 *  freshness); this function only assembles the candidates from real
 *  pool data. Used when the user asks what is getting attention — never
 *  rendered before being asked. */
export async function hotEvents(env: Env): Promise<HotEventsResult> {
  const status = await poolStatus(env);
  const poolLatest = status.reduce<string | null>(
    (acc, s) => (s.frontierIso && (acc === null || s.frontierIso > acc) ? s.frontierIso : acc),
    null,
  );
  const candidates: HotEvent[] = [];
  for (const qid of QUESTION_IDS) {
    const articles = await recentArticles(env, qid, HOT_WINDOW).catch(() => [] as Article[]);
    const withFetched = articles.map((a) => ({ ...a, fetchedAt: a.seendate ?? "" }));
    for (const cluster of clusterArticles(withFetched)) {
      if (cluster.articles.length < HOT_MIN_CLUSTER) continue;
      const domains = new Set(cluster.articles.map((a) => a.domain ?? "(unknown)"));
      const latest = cluster.articles.reduce<string | null>(
        (acc, a) => (a.seendate && (acc === null || a.seendate > acc) ? a.seendate : acc),
        null,
      );
      candidates.push({
        questionId: qid,
        questionLabel: QUESTION_LABELS[qid],
        clusterKey: cluster.key,
        title: cluster.articles[0]?.title ?? null,
        articleCount: cluster.articles.length,
        domainCount: domains.size,
        latestSeendate: latest,
      });
    }
  }
  return {
    events: rankEvents(candidates).slice(0, HOT_TOP_N),
    poolLatest,
    generatedAt: new Date().toISOString(),
  };
}

/** Build (and save) the view for one ranked event, identified by its
 *  cluster key within the same recent window hotEvents uses. The layout
 *  is the deterministic rule-based choice (no model call): the event's
 *  own shape — size, outlet breadth, time span, tone availability —
 *  decides which sections appear and in which order. The verification
 *  gate still runs. Returns null when the cluster is no longer found
 *  (the pool moved on since the ranking was produced). */
export async function buildEventView(
  env: Env,
  qid: QuestionId,
  clusterKey: string,
): Promise<{ viewId: number; spec: ViewSpec; warnings: string[] } | null> {
  const status = (await poolStatus(env)).find((p) => p.questionId === qid);
  const articles = await recentArticles(env, qid, HOT_WINDOW);
  const withFetched = articles.map((a) => ({ ...a, fetchedAt: a.seendate ?? "" }));
  const cluster = clusterArticles(withFetched).find((c) => c.key === clusterKey);
  if (!cluster) return null;
  const trend = await toneTrend(env, qid, 30).catch(() => []);
  const spec = materializeViewSpec({
    questionId: qid,
    generatedAt: new Date().toISOString(),
    origin: "chat",
    cluster,
    choice: ruleBasedChoice(cluster, trend, QUESTION_LABELS[qid]),
    trend,
    pool: {
      total: status?.total ?? 0,
      frontier: status?.frontier ?? null,
      recent24h: status?.recent24h ?? 0,
    },
    baseline: BASELINES[qid] ?? "",
  });
  const warnings = verifyViewSpec(spec, {
    articleUrls: new Set(cluster.articles.map((a) => a.url)),
    articles: cluster.articles,
    baseline: BASELINES[qid] ?? "",
    existingProse: await recentViewProse(env, qid),
  });
  const viewId = await saveView(
    env,
    qid,
    cluster.key,
    spec,
    cluster.articles.length,
    warnings,
    null,
    "rule",
  );
  return { viewId, spec, warnings };
}

// ---------------------------------------------------------------------------
// The radar check (cron + manual trigger share this path)
// ---------------------------------------------------------------------------

export interface RadarCheckSummary {
  checkedAt: string;
  model: string | null;
  neuronsUsedToday: number;
  newViews: number;
  viewIds: number[];
  perQuestion: {
    questionId: QuestionId;
    newArticles: number;
    frontierAdvanced: boolean;
    views: number;
    skipped?: string;
  }[];
}

const MAX_VIEWS_PER_QUESTION = 3;
const MIN_CLUSTER_SIZE = 2;

export async function runRadarCheck(env: Env): Promise<RadarCheckSummary> {
  const checkedAt = new Date().toISOString();
  const status = await poolStatus(env);
  const byQ = new Map(status.map((s) => [s.questionId, s]));
  const summary: RadarCheckSummary = {
    checkedAt,
    model: null,
    neuronsUsedToday: await neuronsUsedToday(env),
    newViews: 0,
    viewIds: [],
    perQuestion: [],
  };

  for (const qid of QUESTION_IDS) {
    const pool = byQ.get(qid);
    if (!pool) continue;
    const state = await env.DB.prepare(
      "SELECT last_check_at, frontier FROM state WHERE question_id =?",
    )
      .bind(qid)
      .first<{ last_check_at: string | null; frontier: string | null }>();
    const frontierAdvanced =
      pool.frontier !== null && (state?.frontier == null || pool.frontier > state.frontier);
    // First ever check: only look back 24h so the standing backfill does
    // not produce an unbounded flood; afterwards, everything since the
    // last check.
    const since = state?.last_check_at ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const fresh = await newArticlesSince(env, qid, since);
    const entry: RadarCheckSummary["perQuestion"][number] = {
      questionId: qid,
      newArticles: fresh.length,
      frontierAdvanced,
      views: 0,
    };
    summary.perQuestion.push(entry);

    if (shouldTrigger(fresh.length, frontierAdvanced)) {
      const model = await pickModel(env);
      summary.model = model;
      if (!model) {
        entry.skipped = "neurons guard: daily budget exhausted";
      } else {
        const clusters = clusterArticles(fresh).filter(
          (c) => c.articles.length >= MIN_CLUSTER_SIZE,
        );
        for (const cluster of clusters.slice(0, MAX_VIEWS_PER_QUESTION)) {
          try {
            const {
              spec,
              warnings,
              choiceSource,
              model: usedModel,
            } = await generateViewForCluster(env, model, qid, cluster, pool, "cron");
            const id = await saveView(
              env,
              qid,
              cluster.key,
              spec,
              cluster.articles.length,
              warnings,
              usedModel,
              choiceSource,
            );
            entry.views++;
            summary.newViews++;
            if (id) summary.viewIds.push(id);
          } catch (err) {
            entry.skipped = `view generation failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }

    await env.DB.prepare(
      "INSERT INTO state (question_id, last_check_at, frontier, total) VALUES (?,?,?,?) " +
        "ON CONFLICT(question_id) DO UPDATE SET last_check_at = excluded.last_check_at, frontier = excluded.frontier, total = excluded.total",
    )
      .bind(qid, checkedAt, pool.frontier, pool.total)
      .run();
  }

  summary.neuronsUsedToday = await neuronsUsedToday(env);
  return summary;
}
