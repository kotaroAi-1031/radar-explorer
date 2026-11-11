// Generative UI view specifications.
//
// A "view" is a dashboard screen for one event (a cluster of articles),
// described as JSON: an ordered list of sections chosen from a fixed
// component catalog. The LLM only chooses the layout (section types and
// headings) and writes prose (title, summary, impact). Every data payload
// (articles, trend points, statistics, source lists) is filled in by code
// from pool data, so nothing the model invents can reach the screen as
// data. The React client renders specs with deterministic components;
// raw HTML from the model is never used.
//
// The verification gate (verifyViewSpec) re-checks the finished spec:
// every article URL in it must come from the input set, and every number
// or URL appearing in model-written prose must appear in the input set.

import {
  allowedNumbersFor,
  extractNumbers,
  extractUrls,
  proseSimilarity,
  seendateToDate,
  type Cluster,
} from "./logic";
import type { Article, ToneTrendPoint } from "./radar-types";

export type ViewSectionType =
  | "summary"
  | "assessment"
  | "article_cards"
  | "timeline"
  | "tone_chart"
  | "source_list"
  | "stat_row";

export const VIEW_SECTION_TYPES: ViewSectionType[] = [
  "summary",
  "article_cards",
  "timeline",
  "tone_chart",
  "source_list",
  "stat_row",
  "assessment",
];

export interface ArticleRef {
  url: string;
  title: string | null;
  domain: string | null;
  seendate: string | null;
  tone: number | null;
}

// Stored specs keep `heading` optional in the type: views saved before
// headings became mandatory may not carry one, and they must still
// render. New choices (ViewChoice) require a heading for every section,
// and materializeViewSpec fills any gap with a default, so every newly
// generated spec has one.
export type ViewSection =
  | { type: "summary"; heading?: string; text: string }
  | {
      type: "assessment";
      heading?: string;
      text?: string;
      baselineExcerpt: string;
    }
  | { type: "article_cards"; heading?: string; articles: ArticleRef[] }
  | { type: "timeline"; heading?: string; articles: ArticleRef[] }
  | { type: "tone_chart"; heading?: string; trend: ToneTrendPoint[] }
  | {
      type: "source_list";
      heading?: string;
      sources: { domain: string; count: number; sampleUrl: string }[];
    }
  | {
      type: "stat_row";
      heading?: string;
      stats: {
        total: number;
        frontier: string | null;
        recent24h: number;
        clusterSize: number;
        domains: number;
      };
    };

export interface ViewSpec {
  version: 1;
  title: string;
  questionId: string;
  generatedAt: string;
  origin: "cron" | "chat";
  sections: ViewSection[];
}

/** How a view's layout/prose choice was produced. Recorded on every
 *  saved view (generated_views.choice_source) so a silent fall back to
 *  the deterministic template can never masquerade as a model choice. */
export type ChoiceSource = "model" | "fallback" | "rule";

/** What the model is allowed to decide: layout + prose. Every section
 *  must carry a heading specific to the event (enforced by the choice
 *  schema and by viewChoiceProblems). */
export interface ViewChoice {
  title: string;
  summary: string;
  impact: string;
  sections: { type: ViewSectionType; heading: string }[];
}

/** Section-count bounds for a generated view, enforced on model choices
 *  (the JSON schema carries the same min/max) and by construction in the
 *  rule-based and fallback choices. */
export const VIEW_SECTIONS_MIN = 3;
export const VIEW_SECTIONS_MAX = 6;

/** Functional default heading per section type, used when a choice
 *  arrives without one (and by the deterministic choices). */
export function defaultHeading(type: ViewSectionType): string {
  switch (type) {
    case "summary":
      return "出来事の概要";
    case "assessment":
      return "見立てへの影響";
    case "article_cards":
      return "報じられた記事";
    case "timeline":
      return "出来事の時系列";
    case "tone_chart":
      return "報道量とトーンの推移";
    case "source_list":
      return "報じた媒体";
    case "stat_row":
      return "数字で見る出来事";
  }
}

/** Structural problems with a layout choice: unknown section types,
 *  duplicates, a section count outside the bounds, or a missing/blank
 *  heading. An empty list means the choice is usable as-is. */
export function viewChoiceProblems(choice: ViewChoice): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of choice.sections) {
    if (!VIEW_SECTION_TYPES.includes(s.type)) problems.push(`未知の部品: ${s.type}`);
    if (seen.has(s.type)) problems.push(`部品の重複: ${s.type}`);
    seen.add(s.type);
    if (!s.heading || !s.heading.trim()) problems.push(`見出しが無い部品: ${s.type}`);
  }
  if (choice.sections.length < VIEW_SECTIONS_MIN) {
    problems.push(`部品が少なすぎる: ${choice.sections.length} < ${VIEW_SECTIONS_MIN}`);
  }
  if (choice.sections.length > VIEW_SECTIONS_MAX) {
    problems.push(`部品が多すぎる: ${choice.sections.length} > ${VIEW_SECTIONS_MAX}`);
  }
  return problems;
}

export interface MaterializeInput<T extends Article> {
  questionId: string;
  generatedAt: string;
  origin: "cron" | "chat";
  cluster: Cluster<T>;
  choice: ViewChoice;
  trend: ToneTrendPoint[];
  pool: { total: number; frontier: string | null; recent24h: number };
  baseline: string;
}

function toRef(a: Article): ArticleRef {
  return {
    url: a.url,
    title: a.title,
    domain: a.domain,
    seendate: a.seendate,
    tone: a.tone,
  };
}

function bySeendateDesc(a: ArticleRef, b: ArticleRef): number {
  return (b.seendate ?? "").localeCompare(a.seendate ?? "");
}

export function sourceListOf(articles: ArticleRef[]): {
  domain: string;
  count: number;
  sampleUrl: string;
}[] {
  const map = new Map<string, { count: number; sampleUrl: string }>();
  for (const a of articles) {
    const domain = a.domain ?? "(unknown)";
    const cur = map.get(domain);
    if (cur) cur.count++;
    else map.set(domain, { count: 1, sampleUrl: a.url });
  }
  return [...map.entries()]
    .map(([domain, v]) => ({ domain, count: v.count, sampleUrl: v.sampleUrl }))
    .sort((x, y) => y.count - x.count);
}

/** Fill a model's layout choice with deterministic data payloads. */
export function materializeViewSpec<T extends Article>(input: MaterializeInput<T>): ViewSpec {
  const refs = input.cluster.articles.map(toRef);
  const desc = [...refs].sort(bySeendateDesc);
  const asc = [...refs].sort((a, b) => bySeendateDesc(b, a));
  const sources = sourceListOf(refs);
  const sections: ViewSection[] = [];
  const seen = new Set<string>();
  for (const want of input.choice.sections) {
    if (seen.has(want.type)) continue; // one of each type per view
    seen.add(want.type);
    const heading = want.heading?.trim() ? want.heading : defaultHeading(want.type);
    switch (want.type) {
      case "summary":
        sections.push({
          type: "summary",
          heading,
          text: input.choice.summary,
        });
        break;
      case "assessment":
        sections.push({
          type: "assessment",
          heading,
          text: input.choice.impact,
          baselineExcerpt: input.baseline.slice(0, 700),
        });
        break;
      case "article_cards":
        sections.push({
          type: "article_cards",
          heading,
          articles: desc.slice(0, 12),
        });
        break;
      case "timeline":
        sections.push({
          type: "timeline",
          heading,
          articles: asc.slice(0, 20),
        });
        break;
      case "tone_chart":
        sections.push({
          type: "tone_chart",
          heading,
          trend: input.trend,
        });
        break;
      case "source_list":
        sections.push({
          type: "source_list",
          heading,
          sources,
        });
        break;
      case "stat_row":
        sections.push({
          type: "stat_row",
          heading,
          stats: {
            total: input.pool.total,
            frontier: input.pool.frontier,
            recent24h: input.pool.recent24h,
            clusterSize: refs.length,
            domains: sources.length,
          },
        });
        break;
    }
  }
  return {
    version: 1,
    title: input.choice.title,
    questionId: input.questionId,
    generatedAt: input.generatedAt,
    origin: input.origin,
    sections,
  };
}

function section(type: ViewSectionType): { type: ViewSectionType; heading: string } {
  return { type, heading: defaultHeading(type) };
}

function factualProse<T extends Article>(
  cluster: Cluster<T>,
  questionLabel: string,
): Pick<ViewChoice, "title" | "summary" | "impact"> {
  const top = cluster.articles[0];
  // The summary names this event's own headlines: a fixed template
  // sentence would be (correctly) flagged by the gate's duplicate
  // detection as recycled prose, and the question label's number would
  // trip the prose-number check. Event-specific and factual only.
  const headlines = [
    ...new Set(
      cluster.articles
        .map((a) => a.title)
        .filter((t): t is string => typeof t === "string" && t.length > 0),
    ),
  ].slice(0, 2);
  const summary =
    headlines.length > 0
      ? `${headlines.map((t) => `「${t}」`).join("、")}など、同じ出来事を報じた記事 ${cluster.articles.length} 件を検知しました。内訳は下の部品のとおりです。`
      : `同じ出来事を報じた記事 ${cluster.articles.length} 件を検知しました。内訳は下の部品のとおりです。`;
  return {
    title: top?.title ?? questionLabel,
    summary,
    impact: "",
  };
}

/** Deterministic fallback layout, used only when the model's output is
 *  unusable (its use is recorded as choice_source = 'fallback'). Prose
 *  is code-composed from facts only. Deliberately a compact set, not
 *  the full catalog in a fixed order. */
export function fallbackChoice<T extends Article>(
  cluster: Cluster<T>,
  questionLabel: string,
): ViewChoice {
  return {
    ...factualProse(cluster, questionLabel),
    sections: [
      section("summary"),
      section("stat_row"),
      section("article_cards"),
      section("assessment"),
    ],
  };
}

/** Deterministic, feature-driven layout for chat-requested views (no
 *  model call, so no neurons spent). The composition — which sections,
 *  in which order — follows the shape of the event itself: how many
 *  articles and outlets cover it, how long it has been unfolding, and
 *  whether tone data exists. Different events therefore get genuinely
 *  different screens instead of one fixed template. */
export function ruleBasedChoice<T extends Article>(
  cluster: Cluster<T>,
  trend: ToneTrendPoint[],
  questionLabel: string,
): ViewChoice {
  const articles = cluster.articles;
  const size = articles.length;
  const domains = sourceListOf(articles.map(toRef)).length;
  const dates = articles
    .map((a) => seendateToDate(a.seendate))
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());
  const spanDays = dates.length
    ? (Math.max(...dates) - Math.min(...dates)) / (24 * 3600 * 1000)
    : 0;
  const toneKnown = trend.some((t) => t.avgTone !== null);
  const types: ViewSectionType[] =
    size <= 3
      ? ["summary", "article_cards", "stat_row"]
      : spanDays >= 2 && toneKnown
        ? ["timeline", "summary", "article_cards", "tone_chart", "stat_row"]
        : domains >= 6 && domains * 2 >= size
          ? ["source_list", "stat_row", "summary", "article_cards", "assessment"]
          : trend.length >= 10
            ? ["tone_chart", "summary", "stat_row", "article_cards", "timeline"]
            : ["article_cards", "summary", "timeline", "stat_row", "assessment"];
  return {
    ...factualProse(cluster, questionLabel),
    sections: types.map(section),
  };
}

// ---------------------------------------------------------------------------
// Verification gate
// ---------------------------------------------------------------------------

export interface ViewGateContext {
  /** URLs of every article in the input cluster. */
  articleUrls: Set<string>;
  /** Articles the prose may draw numbers from. */
  articles: { title: string | null; seendate: string | null }[];
  /** The question's tone trend shown in the view: prose may cite its
   *  daily counts and tones, so they belong to the allowed numbers. */
  trend?: ToneTrendPoint[];
  /** The question's baseline text: a summary that merely copies it is
   *  not a summary of the event and is flagged as a duplicate. */
  baseline?: string;
  /** Title/summary of recently generated views for the same question:
   *  near-identical prose across different events is flagged. */
  existingProse?: { title: string; summary: string }[];
}

/** Similarity at/above which a summary counts as a copy of the baseline. */
export const DUPLICATE_BASELINE_THRESHOLD = 0.6;
/** Similarity at/above which two titles count as the same title. */
export const DUPLICATE_TITLE_THRESHOLD = 0.85;
/** Similarity at/above which two summaries count as the same summary. */
export const DUPLICATE_SUMMARY_THRESHOLD = 0.75;

/** Warnings produced by the duplicate checks carry this prefix, so the
 *  generation path can tell "prose was recycled" (regenerate) apart
 *  from other gate findings. */
export const DUPLICATE_WARNING_PREFIX = "重複検出:";

/** Returns a list of warnings; an empty list means the spec passed. */
export function verifyViewSpec(spec: ViewSpec, ctx: ViewGateContext): string[] {
  const warnings: string[] = [];
  const allowed = allowedNumbersFor(ctx.articles, ctx.trend ?? []);
  const prose: string[] = [spec.title];
  for (const s of spec.sections) {
    if (s.heading) prose.push(s.heading);
    if (s.type === "summary") prose.push(s.text);
    if (s.type === "assessment" && s.text) prose.push(s.text);
    if (s.type === "article_cards" || s.type === "timeline") {
      for (const a of s.articles) {
        if (!ctx.articleUrls.has(a.url)) {
          warnings.push(`入力集合に無い記事URL: ${a.url}`);
        }
      }
    }
    if (s.type === "source_list") {
      for (const src of s.sources) {
        if (!ctx.articleUrls.has(src.sampleUrl)) {
          warnings.push(`入力集合に無い出典URL: ${src.sampleUrl}`);
        }
      }
    }
  }
  for (const text of prose) {
    for (const u of extractUrls(text)) {
      if (!ctx.articleUrls.has(u)) {
        warnings.push(`文章中に実在しないURL: ${u}`);
      }
    }
    for (const n of extractNumbers(text)) {
      if (!allowed.has(n)) {
        warnings.push(`入力に現れない数値: ${n}`);
        break;
      }
    }
  }
  // Duplicate / recycled-prose checks. A view whose title or summary is
  // (near-)identical to another event's view — or whose summary merely
  // copies the baseline — is not a view of this event, however valid its
  // data payloads are.
  const summaryText = spec.sections.find((s) => s.type === "summary")?.text ?? "";
  if (ctx.baseline && summaryText) {
    const sim = proseSimilarity(summaryText, ctx.baseline);
    if (sim >= DUPLICATE_BASELINE_THRESHOLD) {
      warnings.push(
        `${DUPLICATE_WARNING_PREFIX} summary が見立て（baseline）の写しに近い (類似度 ${sim.toFixed(2)})`,
      );
    }
  }
  for (const prev of ctx.existingProse ?? []) {
    const titleSim = proseSimilarity(spec.title, prev.title);
    if (titleSim >= DUPLICATE_TITLE_THRESHOLD) {
      warnings.push(
        `${DUPLICATE_WARNING_PREFIX} タイトルが既存の画面と重複 (類似度 ${titleSim.toFixed(2)}): ${prev.title}`,
      );
    }
    if (summaryText && prev.summary) {
      const sumSim = proseSimilarity(summaryText, prev.summary);
      if (sumSim >= DUPLICATE_SUMMARY_THRESHOLD) {
        warnings.push(
          `${DUPLICATE_WARNING_PREFIX} summary が既存の画面と重複 (類似度 ${sumSim.toFixed(2)}): ${prev.title}`,
        );
      }
    }
  }
  return warnings;
}

/** True when a gate warning came from the duplicate checks. */
export function isDuplicateWarning(warning: string): boolean {
  return warning.startsWith(DUPLICATE_WARNING_PREFIX);
}
