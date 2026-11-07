import { describe, expect, it } from "vitest";
import { clusterArticles } from "./logic";
import type { Article } from "./radar-types";
import {
  fallbackChoice,
  materializeViewSpec,
  sourceListOf,
  verifyViewSpec,
  type ViewChoice,
  type ViewSpec,
} from "./views";

// Classical black-box tests over the view-spec pipeline: given article
// data and a layout choice, what spec comes out, and does the gate accept
// or reject finished specs. No mocks of internals.

function article(
  url: string,
  title: string,
  domain: string,
  seendate: string,
  tone: number | null = null,
): Article {
  return {
    url,
    title,
    domain,
    language: "English",
    sourceCountry: "United States",
    seendate,
    tone,
  };
}

const clusterOf = (articles: Article[]) =>
  clusterArticles(articles.map((a) => ({ ...a, fetchedAt: a.seendate })));

const choice = (over: Partial<ViewChoice> = {}): ViewChoice => ({
  title: "Test event",
  summary: "Something happened.",
  impact: "No change to the assessment.",
  sections: [
    { type: "summary" },
    { type: "stat_row" },
    { type: "article_cards" },
    { type: "timeline" },
    { type: "tone_chart" },
    { type: "source_list" },
    { type: "assessment" },
  ],
  ...over,
});

function materialize(
  articles: Article[],
  ch: ViewChoice = choice(),
  baseline = "baseline text",
): ViewSpec {
  return materializeViewSpec({
    questionId: "q5",
    generatedAt: "2026-11-07T00:00:00.000Z",
    origin: "cron",
    cluster: clusterOf(articles)[0],
    choice: ch,
    trend: [
      { day: "20260814", count: 3, avgTone: -1.5 },
      { day: "20260815", count: 5, avgTone: 0.5 },
    ],
    pool: { total: 3644, frontier: "20260815T000000Z", recent24h: 42 },
    baseline,
  });
}

const three = [
  article(
    "https://a.example/1",
    "Alpha bravo charlie delta echo one",
    "a.example",
    "20260815T030000Z",
    1,
  ),
  article(
    "https://b.example/2",
    "Alpha bravo charlie delta echo two",
    "b.example",
    "20260815T010000Z",
    -2,
  ),
  article(
    "https://a.example/3",
    "Alpha bravo charlie delta echo three",
    "a.example",
    "20260815T020000Z",
    3,
  ),
];

describe("materializeViewSpec", () => {
  it("emits sections in the chosen order with the spec envelope", () => {
    const spec = materialize(three);
    expect(spec.version).toBe(1);
    expect(spec.title).toBe("Test event");
    expect(spec.questionId).toBe("q5");
    expect(spec.origin).toBe("cron");
    expect(spec.sections.map((s) => s.type)).toEqual([
      "summary",
      "stat_row",
      "article_cards",
      "timeline",
      "tone_chart",
      "source_list",
      "assessment",
    ]);
  });

  it("de-duplicates repeated section types", () => {
    const spec = materialize(
      three,
      choice({
        sections: [{ type: "summary" }, { type: "summary" }, { type: "article_cards" }],
      }),
    );
    expect(spec.sections.map((s) => s.type)).toEqual(["summary", "article_cards"]);
  });

  it("puts the model's prose into summary and assessment", () => {
    const spec = materialize(three);
    const summary = spec.sections.find((s) => s.type === "summary");
    const assessment = spec.sections.find((s) => s.type === "assessment");
    expect(summary?.type === "summary" && summary.text).toBe("Something happened.");
    expect(assessment?.type === "assessment" && assessment.text).toBe(
      "No change to the assessment.",
    );
    expect(assessment?.type === "assessment" && assessment.baselineExcerpt).toBe("baseline text");
  });

  it("truncates the baseline excerpt at 700 characters", () => {
    const spec = materialize(three, choice(), "x".repeat(900));
    const assessment = spec.sections.find((s) => s.type === "assessment");
    expect(assessment?.type === "assessment" && assessment.baselineExcerpt.length).toBe(700);
  });

  it("sorts article cards newest first, timeline oldest first", () => {
    const spec = materialize(three);
    const cards = spec.sections.find((s) => s.type === "article_cards");
    const timeline = spec.sections.find((s) => s.type === "timeline");
    expect(cards?.type === "article_cards" && cards.articles.map((a) => a.url)).toEqual([
      "https://a.example/1",
      "https://a.example/3",
      "https://b.example/2",
    ]);
    expect(timeline?.type === "timeline" && timeline.articles.map((a) => a.url)).toEqual([
      "https://b.example/2",
      "https://a.example/3",
      "https://a.example/1",
    ]);
  });

  it("caps article cards at 12", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      article(
        `https://a.example/${i}`,
        `Alpha bravo charlie delta echo ${i}`,
        "a.example",
        `20260815T${String(i).padStart(2, "0")}0000Z`,
      ),
    );
    const spec = materialize(many);
    const cards = spec.sections.find((s) => s.type === "article_cards");
    expect(cards?.type === "article_cards" && cards.articles.length).toBe(12);
  });

  it("stat_row carries pool numbers, cluster size and domain count", () => {
    const spec = materialize(three);
    const stat = spec.sections.find((s) => s.type === "stat_row");
    expect(stat?.type === "stat_row" && stat.stats).toEqual({
      total: 3644,
      frontier: "20260815T000000Z",
      recent24h: 42,
      clusterSize: 3,
      domains: 2,
    });
  });

  it("passes the trend through to the tone chart", () => {
    const spec = materialize(three);
    const chart = spec.sections.find((s) => s.type === "tone_chart");
    expect(chart?.type === "tone_chart" && chart.trend).toHaveLength(2);
  });
});

describe("sourceListOf", () => {
  it("aggregates by domain, most frequent first, with a sample URL", () => {
    const list = sourceListOf(
      three.map((a) => ({
        url: a.url,
        title: a.title,
        domain: a.domain,
        seendate: a.seendate,
        tone: a.tone,
      })),
    );
    expect(list[0]).toEqual({
      domain: "a.example",
      count: 2,
      sampleUrl: "https://a.example/1",
    });
    expect(list[1].domain).toBe("b.example");
    expect(list[1].count).toBe(1);
  });
});

describe("fallbackChoice", () => {
  it("covers the full catalog and mentions the article count", () => {
    const fb = fallbackChoice(clusterOf(three)[0], "問い5");
    expect(fb.sections.map((s) => s.type)).toEqual([
      "summary",
      "stat_row",
      "article_cards",
      "timeline",
      "tone_chart",
      "source_list",
      "assessment",
    ]);
    expect(fb.summary).toContain("3 件");
    expect(fb.title).toBe(three[0].title);
  });
});

describe("verification gate", () => {
  const ctx = (articles: Article[]) => ({
    articleUrls: new Set(articles.map((a) => a.url)),
    articles,
  });

  it("accepts a spec materialised from the same data", () => {
    expect(verifyViewSpec(materialize(three), ctx(three))).toEqual([]);
  });

  it("rejects an article URL that was not in the input", () => {
    const spec = materialize(three);
    const cards = spec.sections.find((s) => s.type === "article_cards");
    if (cards?.type === "article_cards") {
      cards.articles.push({
        url: "https://evil.example/fake",
        title: "fake",
        domain: "evil.example",
        seendate: null,
        tone: null,
      });
    }
    const warnings = verifyViewSpec(spec, ctx(three));
    expect(warnings.some((w) => w.includes("https://evil.example/fake"))).toBe(true);
  });

  it("rejects prose numbers that appear nowhere in the input", () => {
    const spec = materialize(three, choice({ summary: "死者数は500人に上った。" }));
    const warnings = verifyViewSpec(spec, ctx(three));
    expect(warnings.some((w) => w.includes("500"))).toBe(true);
  });

  it("accepts prose numbers that do appear in an input title", () => {
    const withNumber = [
      article(
        "https://a.example/1",
        "Deal worth 60 billion announced",
        "a.example",
        "20260815T030000Z",
      ),
      article(
        "https://b.example/2",
        "Deal worth 60 billion confirmed",
        "b.example",
        "20260815T010000Z",
      ),
    ];
    const spec = materialize(withNumber, choice({ summary: "60 billion の取引が発表された。" }));
    expect(verifyViewSpec(spec, ctx(withNumber))).toEqual([]);
  });

  it("rejects URLs pasted into prose", () => {
    const spec = materialize(
      three,
      choice({ summary: "詳細は https://unknown.example/x を参照。" }),
    );
    const warnings = verifyViewSpec(spec, ctx(three));
    expect(warnings.some((w) => w.includes("unknown.example"))).toBe(true);
  });
});

describe("view generation: mutation strengthening", () => {
  const vctx = (articles: Article[]) => ({
    articleUrls: new Set(articles.map((a) => a.url)),
    articles,
  });

  it("source list labels a missing domain as (unknown)", () => {
    const a1 = {
      ...article("https://x.example/1", "One", "x.example", "20260815T000000Z"),
      domain: null,
    };
    const a2 = {
      ...article("https://x.example/2", "Two", "x.example", "20260815T010000Z"),
      domain: null,
    };
    const spec = materialize([a1, a2], choice({ sections: [{ type: "source_list" }] }));
    const section = spec.sections.find((s) => s.type === "source_list");
    expect(section && "sources" in section && section.sources[0]?.domain).toBe("(unknown)");
  });

  it("gate rejects numbers that appear in a section heading but not in inputs", () => {
    const arts = [
      article("https://a.example/1", "市長が会見を開いた", "a.example", "20260815T000000Z"),
    ];
    const spec = materialize(arts, choice({ sections: [{ type: "summary" }] }));
    const bad = {
      ...spec,
      sections: spec.sections.map((s) =>
        s.type === "summary" ? { ...s, heading: "死者99人を確認" } : s,
      ),
    };
    const warnings = verifyViewSpec(bad, vctx(arts));
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("gate rejects a source_list whose sampleUrl is not from the inputs", () => {
    const arts = [article("https://a.example/1", "通常の記事", "a.example", "20260815T000000Z")];
    const spec = materialize(arts, choice({ sections: [{ type: "source_list" }] }));
    const bad = {
      ...spec,
      sections: spec.sections.map((s) =>
        s.type === "source_list"
          ? {
              ...s,
              sources: s.sources.map((src) => ({
                ...src,
                sampleUrl: "https://evil.example/fake",
              })),
            }
          : s,
      ),
    };
    const warnings = verifyViewSpec(bad, vctx(arts));
    expect(warnings.length).toBeGreaterThan(0);
  });
});
