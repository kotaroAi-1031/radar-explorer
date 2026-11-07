import { describe, expect, it } from "vitest";
import { clusterArticles } from "./logic";
import type { Article } from "./radar-types";
import {
  DUPLICATE_WARNING_PREFIX,
  defaultHeading,
  fallbackChoice,
  materializeViewSpec,
  ruleBasedChoice,
  sourceListOf,
  verifyViewSpec,
  viewChoiceProblems,
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
    { type: "summary", heading: "Summary" },
    { type: "stat_row", heading: "Stats" },
    { type: "article_cards", heading: "Cards" },
    { type: "timeline", heading: "Timeline" },
    { type: "tone_chart", heading: "Chart" },
    { type: "source_list", heading: "Sources" },
    { type: "assessment", heading: "Assessment" },
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
        sections: [
          { type: "summary", heading: "S" },
          { type: "summary", heading: "S" },
          { type: "article_cards", heading: "C" },
        ],
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
  it("is a compact headed set (not the full catalog) and mentions the article count", () => {
    const fb = fallbackChoice(clusterOf(three)[0], "問い5");
    expect(fb.sections.map((s) => s.type)).toEqual([
      "summary",
      "stat_row",
      "article_cards",
      "assessment",
    ]);
    expect(fb.sections.every((s) => s.heading.length > 0)).toBe(true);
    expect(viewChoiceProblems(fb)).toEqual([]);
    expect(fb.summary).toContain("3 件");
    expect(fb.title).toBe(three[0].title);
  });
});

describe("ruleBasedChoice", () => {
  const trendWithTone = [
    { day: "20260810", count: 3, avgTone: -1 },
    { day: "20260811", count: 4, avgTone: 0.5 },
    { day: "20260812", count: 2, avgTone: 1 },
  ];

  it("gives a small event a compact 3-section layout", () => {
    const small = clusterOf(three.slice(0, 2))[0];
    const ch = ruleBasedChoice(small, trendWithTone, "問い5");
    expect(ch.sections.map((s) => s.type)).toEqual(["summary", "article_cards", "stat_row"]);
    expect(viewChoiceProblems(ch)).toEqual([]);
  });

  it("leads with the timeline for a multi-day event with tone data", () => {
    const spread = [
      article(
        "https://a.example/1",
        "Alpha bravo charlie delta echo one",
        "a.example",
        "20260810T030000Z",
        1,
      ),
      article(
        "https://b.example/2",
        "Alpha bravo charlie delta echo two",
        "b.example",
        "20260812T010000Z",
        -2,
      ),
      article(
        "https://c.example/3",
        "Alpha bravo charlie delta echo three",
        "c.example",
        "20260814T020000Z",
        3,
      ),
      article(
        "https://d.example/4",
        "Alpha bravo charlie delta echo four",
        "d.example",
        "20260815T020000Z",
        0,
      ),
    ];
    const ch = ruleBasedChoice(clusterOf(spread)[0], trendWithTone, "問い5");
    expect(ch.sections[0].type).toBe("timeline");
    expect(ch.sections.map((s) => s.type)).toContain("tone_chart");
  });

  it("leads with the source list when coverage is broad across outlets", () => {
    const broad = Array.from({ length: 8 }, (_, i) =>
      article(
        `https://d${i}.example/${i}`,
        "Alpha bravo charlie delta echo shared",
        `d${i}.example`,
        "20260815T030000Z",
      ),
    );
    const ch = ruleBasedChoice(clusterOf(broad)[0], trendWithTone, "問い5");
    expect(ch.sections[0].type).toBe("source_list");
  });

  it("produces different orders for differently shaped events", () => {
    const small = ruleBasedChoice(clusterOf(three.slice(0, 2))[0], trendWithTone, "問い5");
    const burstArts = [
      article(
        "https://a.example/1",
        "Alpha bravo charlie delta echo one",
        "a.example",
        "20260815T030000Z",
      ),
      article(
        "https://b.example/2",
        "Alpha bravo charlie delta echo two",
        "b.example",
        "20260815T040000Z",
      ),
      article(
        "https://a.example/3",
        "Alpha bravo charlie delta echo three",
        "a.example",
        "20260815T050000Z",
      ),
      article(
        "https://b.example/4",
        "Alpha bravo charlie delta echo four",
        "b.example",
        "20260815T060000Z",
      ),
    ];
    const burst = ruleBasedChoice(clusterOf(burstArts)[0], trendWithTone, "問い5");
    expect(burst.sections.map((s) => s.type)).not.toEqual(small.sections.map((s) => s.type));
    expect(burst.sections[0].type).toBe("article_cards");
  });

  it("every section carries the default heading for its type", () => {
    const ch = ruleBasedChoice(clusterOf(three.slice(0, 2))[0], trendWithTone, "問い5");
    for (const s of ch.sections) expect(s.heading).toBe(defaultHeading(s.type));
  });
});

describe("viewChoiceProblems", () => {
  it("accepts a well-formed choice within the bounds", () => {
    const ok = choice({ sections: choice().sections.slice(0, 6) });
    expect(viewChoiceProblems(ok)).toEqual([]);
    // The full 7-part catalog in one view is now over the maximum.
    expect(viewChoiceProblems(choice()).length).toBeGreaterThan(0);
  });

  it("rejects too few / too many sections", () => {
    expect(
      viewChoiceProblems(choice({ sections: [{ type: "summary", heading: "S" }] })).length,
    ).toBeGreaterThan(0);
    const many = choice({
      sections: [...choice().sections, { type: "summary", heading: "again" }],
    });
    expect(viewChoiceProblems(many).length).toBeGreaterThan(0);
  });

  it("rejects a blank heading", () => {
    const bad = choice({
      sections: [
        { type: "summary", heading: "  " },
        { type: "stat_row", heading: "Stats" },
        { type: "article_cards", heading: "Cards" },
      ],
    });
    expect(viewChoiceProblems(bad).some((p) => p.includes("見出し"))).toBe(true);
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
    const spec = materialize(
      [a1, a2],
      choice({ sections: [{ type: "source_list", heading: "Sources" }] }),
    );
    const section = spec.sections.find((s) => s.type === "source_list");
    expect(section && "sources" in section && section.sources[0]?.domain).toBe("(unknown)");
  });

  it("gate rejects numbers that appear in a section heading but not in inputs", () => {
    const arts = [
      article("https://a.example/1", "市長が会見を開いた", "a.example", "20260815T000000Z"),
    ];
    const spec = materialize(arts, choice({ sections: [{ type: "summary", heading: "S" }] }));
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
    const spec = materialize(
      arts,
      choice({ sections: [{ type: "source_list", heading: "Sources" }] }),
    );
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

describe("verification gate: duplicate detection", () => {
  const ctx = (articles: Article[]) => ({
    articleUrls: new Set(articles.map((a) => a.url)),
    articles,
  });

  it("flags a title identical to an existing view's title", () => {
    const spec = materialize(three);
    const warnings = verifyViewSpec(spec, {
      ...ctx(three),
      existingProse: [{ title: "Test event", summary: "Something else entirely happened." }],
    });
    expect(warnings.some((w) => w.startsWith(DUPLICATE_WARNING_PREFIX))).toBe(true);
  });

  it("flags a summary that copies the baseline", () => {
    const baseline =
      "この問いの見立ては、公式レポートと論文の蓄積が進み、検証リポジトリの動向が次の焦点であるというものである";
    const spec = materialize(three, choice({ summary: baseline }), baseline);
    const warnings = verifyViewSpec(spec, { ...ctx(three), baseline });
    expect(warnings.some((w) => w.startsWith(DUPLICATE_WARNING_PREFIX))).toBe(true);
  });

  it("does not flag an event-specific summary against the baseline", () => {
    const baseline =
      "この問いの見立ては、公式レポートと論文の蓄積が進み、検証リポジトリの動向が次の焦点であるというものである";
    const spec = materialize(three, choice(), baseline);
    const warnings = verifyViewSpec(spec, {
      ...ctx(three),
      baseline,
      existingProse: [{ title: "全く別の出来事の画面", summary: "港湾のストライキが拡大した。" }],
    });
    expect(warnings.filter((w) => w.startsWith(DUPLICATE_WARNING_PREFIX))).toEqual([]);
  });

  it("materialise fills a default heading when a choice leaves one blank", () => {
    const spec = materialize(
      three,
      choice({
        sections: [
          { type: "summary", heading: "" },
          { type: "stat_row", heading: "Stats" },
          { type: "article_cards", heading: "Cards" },
        ],
      }),
    );
    const summary = spec.sections.find((s) => s.type === "summary");
    expect(summary?.heading).toBe(defaultHeading("summary"));
  });
});

describe("deterministic prose (rule / fallback)", () => {
  it("summaries differ between events and pass the duplicate gate against each other", () => {
    const other = [
      article("https://x.example/1", "Zulu yankee xray whiskey first", "x.example", "20260815T030000Z"),
      article("https://y.example/2", "Zulu yankee xray whiskey second", "y.example", "20260815T010000Z"),
    ];
    const specA = materialize(three, ruleBasedChoice(clusterOf(three)[0], [], "問い5"));
    const specB = materialize(other, ruleBasedChoice(clusterOf(other)[0], [], "問い5"));
    const ctxFor = (arts: Article[], prose: { title: string; summary: string }[]) => ({
      articleUrls: new Set(arts.map((a) => a.url)),
      articles: arts,
      existingProse: prose,
    });
    const sumA = specA.sections.find((s) => s.type === "summary")?.text ?? "";
    const warningsB = verifyViewSpec(
      specB,
      ctxFor(other, [{ title: specA.title, summary: sumA }]),
    );
    expect(warningsB.filter((w) => w.startsWith(DUPLICATE_WARNING_PREFIX))).toEqual([]);
    // And the rule summary itself contains no stray label number warning.
    expect(warningsB).toEqual([]);
  });
});
