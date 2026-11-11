import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "./env";
import { BASELINES, THREADS } from "./content.generated";
import { QUESTION_IDS, poolStatus, searchArticles, toneTrend, type QuestionId } from "./radar";

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
    async () => {
      try {
        return textResult({ questions: await poolStatus(env) });
      } catch (err) {
        console.error("pool_status failed", err);
        return textResult({ error: "プールの鮮度を取得できませんでした。" });
      }
    },
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
    async (args) => {
      try {
        return textResult({
          articles: await searchArticles(env, {
            questionId: args.question_id as QuestionId,
            keyword: args.keyword,
            since: args.since,
            until: args.until,
            limit: args.limit,
          }),
        });
      } catch (err) {
        console.error("search_articles failed", err);
        return textResult({ error: "記事の検索に失敗しました。" });
      }
    },
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
    async (args) => {
      try {
        return textResult({
          trend: await toneTrend(env, args.question_id as QuestionId, args.days ?? 30),
        });
      } catch (err) {
        console.error("tone_trend failed", err);
        return textResult({ error: "トーン推移を取得できませんでした。" });
      }
    },
  );

  server.registerTool(
    "get_baseline",
    {
      description:
        "指定した問いの「現時点の見立て」（baseline全文）を返す。設計上、書き換えはされない。",
      inputSchema: z.object({ question_id: questionIdSchema }),
    },
    async (args) => {
      try {
        return textResult({ baseline: BASELINES[args.question_id] ?? "" });
      } catch (err) {
        console.error("get_baseline failed", err);
        return textResult({ error: "見立てを取得できませんでした。" });
      }
    },
  );

  server.registerTool(
    "get_thread",
    {
      description:
        "指定した問いの記録スレッド（threads）の内容を返す。長い場合は末尾から最大8000文字。",
      inputSchema: z.object({ question_id: questionIdSchema }),
    },
    async (args) => {
      try {
        const full = THREADS[args.question_id] ?? "";
        return textResult({
          thread: full.length > 8000 ? "…（前略）\n" + full.slice(-8000) : full,
          truncated: full.length > 8000,
        });
      } catch (err) {
        console.error("get_thread failed", err);
        return textResult({ error: "記録スレッドを取得できませんでした。" });
      }
    },
  );

  server.registerTool(
    "list_views",
    {
      description: "自動生成された画面（Generative UI スペック）の一覧を返す。新しい順、最大20件。",
      inputSchema: z.object({
        question_id: questionIdSchema.optional(),
      }),
    },
    async (args) => {
      try {
        const rs = args.question_id
          ? await env.DB.prepare(
              "SELECT id, question_id, title, article_count, verified, origin, created_at FROM generated_views WHERE question_id = ? ORDER BY id DESC LIMIT 20",
            )
              .bind(args.question_id)
              .all()
          : await env.DB.prepare(
              "SELECT id, question_id, title, article_count, verified, origin, created_at FROM generated_views ORDER BY id DESC LIMIT 20",
            ).all();
        return textResult({ views: rs.results });
      } catch (err) {
        console.error("list_views failed", err);
        return textResult({ error: "生成済みの画面を取得できませんでした。" });
      }
    },
  );

  server.registerTool(
    "get_view",
    {
      description:
        "生成済み画面のスペック（部品とデータのJSON）を1件返す。描画はクライアント側の決定的コンポーネントが行う。",
      inputSchema: z.object({ id: z.number().int() }),
    },
    async (args) => {
      try {
        const row = await env.DB.prepare(
          "SELECT id, question_id, title, spec, article_count, verified, warnings, origin, created_at FROM generated_views WHERE id = ?",
        )
          .bind(args.id)
          .first();
        if (!row) return textResult({ error: "view not found" });
        return textResult({
          view: { ...row, spec: JSON.parse(String(row.spec)) },
        });
      } catch (err) {
        console.error("get_view failed", err);
        return textResult({ error: "画面を取得できませんでした。" });
      }
    },
  );

  return server;
}

/** Stateless MCP endpoint handler for /mcp (per-request server factory). */
export function mcpHandler(env: Env) {
  return createMcpHandler(() => buildMcpServer(env), { route: "/mcp" });
}
