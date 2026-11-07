import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "./env";
import { BASELINES, THREADS } from "./content.generated";
import {
  QUESTION_IDS,
  poolStatus,
  searchArticles,
  toneTrend,
  type QuestionId,
} from "./radar";

const questionIdSchema = z.enum(QUESTION_IDS);

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "radar-explorer",
    version: "0.1.0",
  });

  server.registerTool(
    "pool_status",
    {
      description:
        "問いごとに、収集プールの鮮度（最先端の記事日時=frontier、累計件数、frontier直近24時間の件数、欠落の有無）を返す。",
      inputSchema: z.object({}),
    },
    async () => textResult({ questions: await poolStatus(env) }),
  );

  server.registerTool(
    "search_articles",
    {
      description:
        "指定した問いのプールから記事を検索する。キーワード（タイトル部分一致）、期間（GDELT形式 seendate: YYYYMMDDTHHMMSSZ）、上限を指定できる。新しい順。",
      inputSchema: z.object({
        question_id: questionIdSchema,
        keyword: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async (args) =>
      textResult({
        articles: await searchArticles(env, {
          questionId: args.question_id as QuestionId,
          keyword: args.keyword,
          since: args.since,
          until: args.until,
          limit: args.limit,
        }),
      }),
  );

  server.registerTool(
    "tone_trend",
    {
      description:
        "指定した問いについて、日別の記事件数と平均tone（GDELTの論調指標）を返す。日数は最大90。",
      inputSchema: z.object({
        question_id: questionIdSchema,
        days: z.number().int().min(1).max(90).optional(),
      }),
    },
    async (args) =>
      textResult({
        trend: await toneTrend(
          env,
          args.question_id as QuestionId,
          args.days ?? 30,
        ),
      }),
  );

  server.registerTool(
    "get_baseline",
    {
      description:
        "指定した問いの「現時点の見立て」（baseline全文）を返す。設計上、書き換えはされない。",
      inputSchema: z.object({ question_id: questionIdSchema }),
    },
    async (args) => textResult({ baseline: BASELINES[args.question_id] ?? "" }),
  );

  server.registerTool(
    "get_thread",
    {
      description:
        "指定した問いの記録スレッド（threads）の内容を返す。長い場合は末尾から最大8000文字。",
      inputSchema: z.object({ question_id: questionIdSchema }),
    },
    async (args) => {
      const full = THREADS[args.question_id] ?? "";
      return textResult({
        thread: full.length > 8000 ? "…（前略）\n" + full.slice(-8000) : full,
        truncated: full.length > 8000,
      });
    },
  );

  return server;
}

/** Stateless MCP endpoint handler for /mcp (per-request server factory). */
export function mcpHandler(env: Env) {
  return createMcpHandler(() => buildMcpServer(env), { route: "/mcp" });
}
