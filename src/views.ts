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

import { allowedNumbersFor, extractNumbers, extractUrls, type Cluster } from "./logic";
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

/** What the model is allowed to decide: layout + prose. */
export interface ViewChoice {
  title: string;
  summary: string;
  impact: string;
  sections: { type: ViewSectionType; heading?: string }[];
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
    switch (want.type) {
      case "summary":
        sections.push({
          type: "summary",
          heading: want.heading,
          text: input.choice.summary,
        });
        break;
      case "assessment":
        sections.push({
          type: "assessment",
          heading: want.heading,
          text: input.choice.impact,
          baselineExcerpt: input.baseline.slice(0, 700),
        });
        break;
      case "article_cards":
        sections.push({
          type: "article_cards",
          heading: want.heading,
          articles: desc.slice(0, 12),
        });
        break;
      case "timeline":
        sections.push({
          type: "timeline",
          heading: want.heading,
          articles: asc.slice(0, 20),
        });
        break;
      case "tone_chart":
        sections.push({
          type: "tone_chart",
          heading: want.heading,
          trend: input.trend,
        });
        break;
      case "source_list":
        sections.push({
          type: "source_list",
          heading: want.heading,
          sources,
        });
        break;
      case "stat_row":
        sections.push({
          type: "stat_row",
          heading: want.heading,
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

/** Deterministic fallback layout, used when the model's output is unusable
 *  and for chat-requested views (no model call). Prose is code-composed
 *  from facts only. */
export function fallbackChoice<T extends Article>(
  cluster: Cluster<T>,
  questionLabel: string,
): ViewChoice {
  const top = cluster.articles[0];
  return {
    title: top?.title ?? questionLabel,
    summary:
      `${questionLabel}について、同じ出来事を報じた記事 ${cluster.articles.length} 件を検知しました。` +
      `内訳は下の部品のとおりです。`,
    impact: "",
    sections: [
      { type: "summary" },
      { type: "stat_row" },
      { type: "article_cards" },
      { type: "timeline" },
      { type: "tone_chart" },
      { type: "source_list" },
      { type: "assessment" },
    ],
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
}

/** Returns a list of warnings; an empty list means the spec passed. */
export function verifyViewSpec(spec: ViewSpec, ctx: ViewGateContext): string[] {
  const warnings: string[] = [];
  const allowed = allowedNumbersFor(ctx.articles);
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
  return warnings;
}
