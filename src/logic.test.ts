import { describe, expect, it } from "vitest";
import {
  MODEL_FAST,
  MODEL_MAIN,
  allowedNumbersFor,
  clusterArticles,
  dateToSeendate,
  estimateNeurons,
  extractNumbers,
  extractUrls,
  pickModelForUsage,
  rankEvents,
  seendateToDate,
  shouldTrigger,
  titleTokens,
  type RankedEventCandidate,
} from "./logic";

// Classical (Detroit-school) black-box tests: behaviour of the public
// functions, input -> output. No mocks, no internal-state assertions.

describe("seendate conversion", () => {
  it("round-trips a GDELT seendate", () => {
    const d = seendateToDate("20260815T120000Z");
    expect(d?.toISOString()).toBe("2026-08-15T12:00:00.000Z");
    expect(dateToSeendate(d as Date)).toBe("20260815T120000Z");
  });

  it("rejects malformed input", () => {
    expect(seendateToDate(null)).toBeNull();
    expect(seendateToDate("")).toBeNull();
    expect(seendateToDate("2026-08-15")).toBeNull();
    expect(seendateToDate("not a date")).toBeNull();
  });
});

describe("neurons estimation", () => {
  it("prices the main model (Llama 4 Scout) at the published rates", () => {
    expect(estimateNeurons(MODEL_MAIN, 1_000_000, 0)).toBeCloseTo(24545);
    expect(estimateNeurons(MODEL_MAIN, 0, 1_000_000)).toBeCloseTo(77273);
    expect(estimateNeurons(MODEL_MAIN, 0, 0)).toBe(0);
  });

  it("prices the 8B model cheaper", () => {
    const fast = estimateNeurons(MODEL_FAST, 1_000_000, 1_000_000);
    const main = estimateNeurons(MODEL_MAIN, 1_000_000, 1_000_000);
    expect(fast).toBeCloseTo(4119 + 34868);
    expect(fast).toBeLessThan(main);
  });
});

describe("neurons guard", () => {
  it("uses the main model below 6,000", () => {
    expect(pickModelForUsage(0)).toBe(MODEL_MAIN);
    expect(pickModelForUsage(5999)).toBe(MODEL_MAIN);
  });

  it("falls back to the fast model from 6,000 to 7,999", () => {
    expect(pickModelForUsage(6000)).toBe(MODEL_FAST);
    expect(pickModelForUsage(7999)).toBe(MODEL_FAST);
  });

  it("stops generation at 8,000", () => {
    expect(pickModelForUsage(8000)).toBeNull();
    expect(pickModelForUsage(10000)).toBeNull();
  });
});

describe("diff trigger", () => {
  it("does not trigger below the threshold without frontier movement", () => {
    expect(shouldTrigger(0, false)).toBe(false);
    expect(shouldTrigger(9, false)).toBe(false);
  });

  it("triggers at the threshold", () => {
    expect(shouldTrigger(10, false)).toBe(true);
    expect(shouldTrigger(250, false)).toBe(true);
  });

  it("triggers on frontier movement when articles arrived", () => {
    expect(shouldTrigger(1, true)).toBe(true);
  });

  it("does not trigger when nothing arrived, even if the frontier moved", () => {
    expect(shouldTrigger(0, true)).toBe(false);
  });
});

describe("title tokens", () => {
  it("drops stopwords, short words and punctuation, folds case", () => {
    const tokens = titleTokens("The Big-Ship Sails, Again!");
    expect(tokens.has("big-ship".split("-")[0])).toBe(true);
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("sails")).toBe(true);
    expect([...tokens].every((t) => t === t.toLowerCase())).toBe(true);
  });

  it("keeps CJK tokens", () => {
    const tokens = titleTokens("イスラエル軍がガザ地区を攻撃");
    expect(tokens.size).toBeGreaterThan(0);
  });
});

describe("clustering", () => {
  const a = (url: string, title: string | null) => ({ url, title });

  it("groups articles about the same event and separates others", () => {
    const clusters = clusterArticles([
      a("https://x/1", "Alpha bravo charlie delta echo summit"),
      a("https://x/2", "Alpha bravo charlie delta echo meeting"),
      a("https://x/3", "Zulu yankee xray whiskey tango festival"),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].articles.map((v) => v.url)).toEqual(["https://x/1", "https://x/2"]);
    expect(clusters[1].articles).toHaveLength(1);
  });

  it("clusters at exactly 60 percent token overlap, not below", () => {
    const at = clusterArticles([
      a("https://x/1", "alpha bravo charlie delta echo"),
      a("https://x/2", "alpha bravo charlie foxtrot golf"),
    ]);
    expect(at).toHaveLength(1);
    const below = clusterArticles([
      a("https://x/1", "alpha bravo charlie delta echo"),
      a("https://x/2", "alpha bravo foxtrot golf hotel"),
    ]);
    expect(below).toHaveLength(2);
  });

  it("skips articles without usable titles", () => {
    const clusters = clusterArticles([
      a("https://x/1", null),
      a("https://x/2", "!!!"),
      a("https://x/3", "alpha bravo charlie"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].articles[0].url).toBe("https://x/3");
  });

  it("returns an empty list for empty input", () => {
    expect(clusterArticles([])).toEqual([]);
  });

  it("sorts clusters by size, largest first", () => {
    const clusters = clusterArticles([
      a("https://x/1", "solo unique words here"),
      a("https://x/2", "alpha bravo charlie delta echo one"),
      a("https://x/3", "alpha bravo charlie delta echo two"),
      a("https://x/4", "alpha bravo charlie delta echo three"),
    ]);
    expect(clusters[0].articles).toHaveLength(3);
    expect(clusters[1].articles).toHaveLength(1);
  });
});

describe("number and URL extraction", () => {
  it("extracts integers, decimals and comma-grouped numbers", () => {
    expect(extractNumbers("約60億ドルと 1,250 件、3.5%")).toEqual(["60", "1,250", "3.5"]);
  });

  it("extracts URLs", () => {
    expect(extractUrls("see https://example.com/a?b=1 and http://x.jp/")).toEqual([
      "https://example.com/a?b=1",
      "http://x.jp/",
    ]);
  });

  it("allowed numbers come from titles, seendates and the count", () => {
    const allowed = allowedNumbersFor([
      { title: "60 billion deal signed", seendate: "20260815T120000Z" },
      { title: "no numbers here", seendate: null },
    ]);
    expect(allowed.has("60")).toBe(true);
    expect(allowed.has("20260815")).toBe(true);
    expect(allowed.has("2")).toBe(true); // the article count
    expect(allowed.has("999")).toBe(false);
  });
});

describe("mutation strengthening (behaviour-level)", () => {
  it("pickModelForUsage returns the literal model ids of the policy", () => {
    expect(pickModelForUsage(0)).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
    expect(pickModelForUsage(5999)).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
    expect(pickModelForUsage(6000)).toBe("@cf/meta/llama-3.1-8b-instruct-fp8-fast");
    expect(pickModelForUsage(7999)).toBe("@cf/meta/llama-3.1-8b-instruct-fp8-fast");
  });

  it("titleTokens drops English stopwords and short tokens", () => {
    const tokens = titleTokens("The war and the talks are on for a summit");
    for (const stop of ["the", "and", "for", "on"]) {
      expect(tokens.has(stop)).toBe(false);
    }
    expect(tokens.has("war")).toBe(true);
    expect(tokens.has("summit")).toBe(true);
  });

  it("seendate round-trip preserves minutes and seconds", () => {
    expect(seendateToDate("20260815T123456Z")?.toISOString()).toBe("2026-08-15T12:34:56.000Z");
  });

  it("seendate with trailing garbage is rejected", () => {
    expect(seendateToDate("20260815T123456ZEXTRA")).toBeNull();
    expect(seendateToDate("20260815T123456")).toBeNull();
  });

  it("seendate with leading garbage is rejected", () => {
    expect(seendateToDate("X20260815T123456Z")).toBeNull();
    expect(seendateToDate(" 20260815T123456Z")).toBeNull();
  });

  it("titleTokens drops every common English stopword of length >= 3", () => {
    const stopwords = [
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
    ];
    for (const w of stopwords) {
      const tokens = titleTokens(`${w} summit treaty`);
      expect(tokens.has(w)).toBe(false);
      expect(tokens.has("summit")).toBe(true);
    }
  });
});

describe("event ranking", () => {
  const ev = (
    questionId: string,
    clusterKey: string,
    articleCount: number,
    domainCount: number,
    latestSeendate: string | null,
  ): RankedEventCandidate => ({
    questionId,
    clusterKey,
    title: `${clusterKey} headline`,
    articleCount,
    domainCount,
    latestSeendate,
  });
  const keys = (list: RankedEventCandidate[]) => list.map((e) => e.clusterKey);

  it("orders by coverage volume (article count), largest first", () => {
    const ranked = rankEvents([
      ev("q1", "small", 3, 3, "20260814T000000Z"),
      ev("q2", "big", 25, 4, "20260810T000000Z"),
      ev("q3", "mid", 10, 9, "20260814T000000Z"),
    ]);
    expect(keys(ranked)).toEqual(["big", "mid", "small"]);
  });

  it("breaks article-count ties by outlet breadth (domain count)", () => {
    const ranked = rankEvents([
      ev("q1", "narrow", 10, 2, "20260814T000000Z"),
      ev("q2", "wide", 10, 8, "20260801T000000Z"),
    ]);
    expect(keys(ranked)).toEqual(["wide", "narrow"]);
  });

  it("breaks remaining ties by freshness, newest first, missing dates last", () => {
    const ranked = rankEvents([
      ev("q1", "old", 10, 5, "20260801T000000Z"),
      ev("q2", "new", 10, 5, "20260814T000000Z"),
      ev("q3", "nodate", 10, 5, null),
    ]);
    expect(keys(ranked)).toEqual(["new", "old", "nodate"]);
  });

  it("breaks ties between two dateless events by question id", () => {
    const ranked = rankEvents([ev("q3", "later-q", 7, 7, null), ev("q1", "earlier-q", 7, 7, null)]);
    expect(keys(ranked)).toEqual(["earlier-q", "later-q"]);
  });

  it("is fully deterministic on complete ties (question id, then cluster key)", () => {
    const input = [
      ev("q2", "b-key", 5, 5, "20260814T000000Z"),
      ev("q1", "z-key", 5, 5, "20260814T000000Z"),
      ev("q1", "a-key", 5, 5, "20260814T000000Z"),
    ];
    expect(keys(rankEvents(input))).toEqual(["a-key", "z-key", "b-key"]);
    expect(keys(rankEvents([...input].reverse()))).toEqual(["a-key", "z-key", "b-key"]);
  });

  it("does not mutate the input array", () => {
    const input = [ev("q1", "b", 1, 1, null), ev("q2", "a", 9, 1, null)];
    rankEvents(input);
    expect(keys(input)).toEqual(["b", "a"]);
  });

  it("returns an empty list for empty input", () => {
    expect(rankEvents([])).toEqual([]);
  });
});

describe("chat model policy", () => {
  it("chat uses Mistral Small 3.1 (Scout returns empty completions via createAI)", async () => {
    const { MODEL_CHAT } = await import("./logic");
    expect(MODEL_CHAT).toBe("@cf/mistralai/mistral-small-3.1-24b-instruct");
    expect(estimateNeurons(MODEL_CHAT, 1_000_000, 0)).toBeCloseTo(31909);
    expect(estimateNeurons(MODEL_CHAT, 0, 1_000_000)).toBeCloseTo(50455);
  });
});
