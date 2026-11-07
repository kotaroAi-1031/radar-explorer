import { createClient, type Client } from "@libsql/client/web";
import type { Env } from "./env";
import { dateToSeendate, seendateToDate } from "./logic";
import type { Article, ToneTrendPoint } from "./radar-types";

export { dateToSeendate, seendateToDate };
export type { Article, ToneTrendPoint };

export const QUESTION_IDS = ["q1", "q2", "q3", "q4", "q5", "q6"] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

export const QUESTION_LABELS: Record<QuestionId, string> = {
  q1: "問い1：イスラエル・ガザ・イランと米以関係",
  q2: "問い2：米国の対中南米・対麻薬政策とカルテル",
  q3: "問い3：日本は経由地としてどう見られているか",
  q4: "問い4：テック界隈のパワー構造（YC・Altman・Thiel・Musk・EA）",
  q5: "問い5：AIの一次情報（公式レポート・論文・検証）",
  q6: "問い6：セキュリティ実務（侵害事例と見直し点）",
};

interface TursoEntry {
  url: string;
  authToken: string;
}

const clientCache = new Map<string, Client>();

export function tursoClient(env: Env, qid: QuestionId): Client {
  const all = JSON.parse(env.TURSO_DATABASES_JSON) as Record<string, TursoEntry>;
  const entry = all[qid];
  if (!entry) throw new Error(`no Turso database configured for ${qid}`);
  let client = clientCache.get(entry.url);
  if (!client) {
    client = createClient({ url: entry.url, authToken: entry.authToken });
    clientCache.set(entry.url, client);
  }
  return client;
}

export interface PoolStatusEntry {
  questionId: QuestionId;
  label: string;
  total: number;
  frontier: string | null;
  frontierIso: string | null;
  recent24h: number;
  /** True when the pool holds nothing at all — the "collection gap". */
  missing: boolean;
}

export async function poolStatus(env: Env): Promise<PoolStatusEntry[]> {
  const out: PoolStatusEntry[] = [];
  for (const qid of QUESTION_IDS) {
    const db = tursoClient(env, qid);
    const agg = await db.execute(
      "SELECT COUNT(*) AS total, MAX(seendate) AS frontier FROM articles",
    );
    const total = Number(agg.rows[0]?.total ?? 0);
    const frontier = (agg.rows[0]?.frontier as string | null) ?? null;
    let recent24h = 0;
    const frontierDate = seendateToDate(frontier);
    if (frontierDate) {
      const since = dateToSeendate(new Date(frontierDate.getTime() - 24 * 3600 * 1000));
      const r = await db.execute({
        sql: "SELECT COUNT(*) AS c FROM articles WHERE seendate >= ?",
        args: [since],
      });
      recent24h = Number(r.rows[0]?.c ?? 0);
    }
    out.push({
      questionId: qid,
      label: QUESTION_LABELS[qid],
      total,
      frontier,
      frontierIso: frontierDate ? frontierDate.toISOString() : null,
      recent24h,
      missing: total === 0,
    });
  }
  return out;
}

export interface SearchOptions {
  questionId: QuestionId;
  keyword?: string;
  /** GDELT seendate lower bound ("YYYYMMDDTHHMMSSZ") */
  since?: string;
  until?: string;
  limit?: number;
}

export async function searchArticles(env: Env, opts: SearchOptions): Promise<Article[]> {
  const db = tursoClient(env, opts.questionId);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const clauses = ["question_id = ?"];
  const args: (string | number)[] = [opts.questionId];
  if (opts.keyword) {
    clauses.push("title LIKE ?");
    args.push(`%${opts.keyword}%`);
  }
  if (opts.since) {
    clauses.push("seendate >= ?");
    args.push(opts.since);
  }
  if (opts.until) {
    clauses.push("seendate <= ?");
    args.push(opts.until);
  }
  args.push(limit);
  const rs = await db.execute({
    sql:
      "SELECT url, title, domain, language, source_country, seendate, tone " +
      `FROM articles WHERE ${clauses.join(" AND ")} ORDER BY seendate DESC LIMIT ?`,
    args,
  });
  return rs.rows.map((r) => ({
    url: String(r.url),
    title: (r.title as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    language: (r.language as string | null) ?? null,
    sourceCountry: (r.source_country as string | null) ?? null,
    seendate: (r.seendate as string | null) ?? null,
    tone: r.tone === null ? null : Number(r.tone),
  }));
}

/** The pool's newest articles for a question, latest first. Used for
 *  event clustering (attention ranking and event views), where the input
 *  window must be identical across calls so cluster keys stay stable. */
export async function recentArticles(
  env: Env,
  questionId: QuestionId,
  limit = 150,
): Promise<Article[]> {
  const db = tursoClient(env, questionId);
  const rs = await db.execute({
    sql:
      "SELECT url, title, domain, language, source_country, seendate, tone " +
      "FROM articles WHERE question_id = ? ORDER BY seendate DESC, url ASC LIMIT ?",
    args: [questionId, Math.min(Math.max(limit, 1), 200)],
  });
  return rs.rows.map((r) => ({
    url: String(r.url),
    title: (r.title as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    language: (r.language as string | null) ?? null,
    sourceCountry: (r.source_country as string | null) ?? null,
    seendate: (r.seendate as string | null) ?? null,
    tone: r.tone === null ? null : Number(r.tone),
  }));
}

export async function toneTrend(
  env: Env,
  questionId: QuestionId,
  days = 30,
): Promise<ToneTrendPoint[]> {
  const db = tursoClient(env, questionId);
  const rs = await db.execute({
    sql:
      "SELECT substr(seendate, 1, 8) AS day, COUNT(*) AS c, AVG(tone) AS t " +
      "FROM articles WHERE seendate IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT ?",
    args: [Math.min(Math.max(days, 1), 90)],
  });
  return rs.rows
    .map((r) => ({
      day: String(r.day),
      count: Number(r.c),
      avgTone: r.t === null ? null : Number(r.t),
    }))
    .reverse();
}

/** Articles inserted into the pool after `isoTime` (collector fetched_at). */
export async function newArticlesSince(
  env: Env,
  qid: QuestionId,
  isoTime: string,
  cap = 400,
): Promise<(Article & { fetchedAt: string })[]> {
  const db = tursoClient(env, qid);
  const rs = await db.execute({
    sql:
      "SELECT url, title, domain, language, source_country, seendate, tone, fetched_at " +
      "FROM articles WHERE fetched_at > ? ORDER BY fetched_at ASC LIMIT ?",
    args: [isoTime, cap],
  });
  return rs.rows.map((r) => ({
    url: String(r.url),
    title: (r.title as string | null) ?? null,
    domain: (r.domain as string | null) ?? null,
    language: (r.language as string | null) ?? null,
    sourceCountry: (r.source_country as string | null) ?? null,
    seendate: (r.seendate as string | null) ?? null,
    tone: r.tone === null ? null : Number(r.tone),
    fetchedAt: String(r.fetched_at),
  }));
}
