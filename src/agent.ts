import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { createAI } from "agents/models/ai-sdk";
import { z } from "zod";
import type { Env } from "./env";
import { BASELINES, THREADS } from "./content.generated";
import {
  MODEL_MAIN,
  estimateNeurons,
  recordNeurons,
  runRadarCheck,
  type RadarCheckSummary,
} from "./generate";
import {
  QUESTION_IDS,
  poolStatus,
  searchArticles,
  toneTrend,
  type QuestionId,
} from "./radar";

const questionIdSchema = z.enum(QUESTION_IDS);

const SYSTEM_PROMPT = `あなたは「一次情報レーダー探検UI」の案内役です。一次情報レーダーは6つの「監視する問い」（中東、米国の対中南米・対麻薬政策、日本の経由地化、テックのパワー構造、AI一次情報、セキュリティ実務）について、世界中の報道を収集プール（GDELT）に貯め、裏取りしながら見立てを更新していく知識ベースです。

ルール:
- 事実の主張は必ずツールで取得した記事・見立てに基づいて行い、出典（媒体ドメインとURL）を添える。ツールで確認できないことは「プールにはまだ無い」と正直に言う。
- 収集プールは現在バックフィル中で、frontier（最新の記事日時）が現在日時より大幅に遅れている問いがある。pool_status で鮮度を確認し、欠落や遅れがあれば最初に断る。プールに無い出来事を、起きていないかのように語らない。
- get_baseline（現時点の見立て）と get_thread（記録）を読んでから、その問いの見立てについて語る。
- 回答は日本語で、結論から簡潔に。推測と事実を区別する。`;

function buildTools(env: Env) {
  return {
    pool_status: tool({
      description:
        "問いごとの収集プールの鮮度（frontier、累計、直近24h件数、欠落）を返す。探検の最初に必ず呼ぶ。",
      inputSchema: z.object({}),
      execute: async () => ({ questions: await poolStatus(env) }),
    }),
    search_articles: tool({
      description:
        "問いのプールから記事を検索する（タイトル部分一致のキーワード、期間、上限）。新しい順。",
      inputSchema: z.object({
        question_id: questionIdSchema,
        keyword: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (args) => ({
        articles: await searchArticles(env, {
          questionId: args.question_id as QuestionId,
          keyword: args.keyword,
          since: args.since,
          until: args.until,
          limit: args.limit,
        }),
      }),
    }),
    tone_trend: tool({
      description: "問いごとに日別の記事件数と平均toneを返す。",
      inputSchema: z.object({
        question_id: questionIdSchema,
        days: z.number().int().min(1).max(90).optional(),
      }),
      execute: async (args) => ({
        trend: await toneTrend(
          env,
          args.question_id as QuestionId,
          args.days ?? 30,
        ),
      }),
    }),
    get_baseline: tool({
      description: "問いの「現時点の見立て」（baseline全文）を返す。",
      inputSchema: z.object({ question_id: questionIdSchema }),
      execute: async (args) => ({
        baseline: BASELINES[args.question_id] ?? "",
      }),
    }),
    get_thread: tool({
      description: "問いの記録スレッドを返す（長い場合は末尾8000文字）。",
      inputSchema: z.object({ question_id: questionIdSchema }),
      execute: async (args) => {
        const full = THREADS[args.question_id] ?? "";
        return {
          thread: full.length > 8000 ? "…（前略）\n" + full.slice(-8000) : full,
          truncated: full.length > 8000,
        };
      },
    }),
    list_drafts: tool({
      description:
        "自動生成された下書き（threads形式）の一覧を返す。status=pending は承認待ち。",
      inputSchema: z.object({
        question_id: questionIdSchema.optional(),
      }),
      execute: async (args) => {
        const rs = args.question_id
          ? await env.DB.prepare(
              "SELECT id, question_id, headline, body, article_count, verified, warnings, status, model, created_at FROM drafts WHERE question_id = ? ORDER BY id DESC LIMIT 20",
            )
              .bind(args.question_id)
              .all()
          : await env.DB.prepare(
              "SELECT id, question_id, headline, body, article_count, verified, warnings, status, model, created_at FROM drafts ORDER BY id DESC LIMIT 20",
            ).all();
        return { drafts: rs.results };
      },
    }),
  };
}

export class ExplorerAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
  ) {
    const ai = createAI({ binding: this.env.AI });
    const result = streamText({
      model: ai(MODEL_MAIN),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(this.messages),
      tools: buildTools(this.env),
      stopWhen: stepCountIs(6),
      onFinish: async (event) => {
        const usage = event.totalUsage;
        if (usage) {
          await recordNeurons(
            this.env,
            estimateNeurons(
              MODEL_MAIN,
              usage.inputTokens ?? 0,
              usage.outputTokens ?? 0,
            ),
          ).catch(() => undefined);
        }
        await onFinish(event as never);
      },
    });
    return result.toUIMessageStreamResponse();
  }

  /** Cron entry point (also callable from /api/check-now for verification).
   *  Broadcasts a notice to connected screens when drafts were created. */
  async runRadarCheck(): Promise<RadarCheckSummary> {
    const summary = await runRadarCheck(this.env);
    if (summary.newDrafts > 0) {
      this.broadcast(
        JSON.stringify({
          type: "radar-drafts",
          message: "新しい下書きができました",
          newDrafts: summary.newDrafts,
          draftIds: summary.draftIds,
          checkedAt: summary.checkedAt,
        }),
      );
    }
    return summary;
  }
}
