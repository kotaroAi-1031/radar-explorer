import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { createAI } from "agents/models/ai-sdk";
import { z } from "zod";
import type { Env } from "./env";
import { BASELINES, THREADS } from "./content.generated";
import {
  MODEL_CHAT,
  buildEventView,
  estimateNeurons,
  hotEvents,
  recordNeurons,
  runRadarCheck,
  saveView,
  type RadarCheckSummary,
} from "./generate";
import { clusterArticles } from "./logic";
import { fallbackChoice, materializeViewSpec, verifyViewSpec } from "./views";
import {
  QUESTION_IDS,
  QUESTION_LABELS,
  poolStatus,
  searchArticles,
  toneTrend,
  type QuestionId,
} from "./radar";

const SYSTEM_PROMPT = `あなたは「一次情報レーダー探検UI」の案内役です。一次情報レーダーは6つの「監視する問い」（中東、米国の対中南米・対麻薬政策、日本の経由地化、テックのパワー構造、AI一次情報、セキュリティ実務）について、世界中の報道を収集プール（GDELT）に貯め、裏取りしながら見立てを更新していく知識ベースです。

ルール:
- 事実の主張は必ずツールで取得した記事・見立てに基づいて行い、出典（媒体ドメインとURL）を添える。ツールで確認できないことは「プールにはまだ無い」と正直に言う。
- 収集プールは現在バックフィル中で、frontier（最新の記事日時）が現在日時より大幅に遅れている問いがある。pool_status で鮮度を確認し、欠落や遅れがあれば最初に断る。プールに無い出来事を、起きていないかのように語らない。
- get_baseline（現時点の見立て）と get_thread（記録）を読んでから、その問いの見立てについて語る。
- 問いの全体像を画面で見たいと明示的に言われたら build_view で画面（ダッシュボード）を生成して見せる。自分から進んで画面を生成しない。生成済みの画面は list_views で引ける。
- 「いま何が注目されている？」「世界情勢の注目は？」のように漠然と聞かれたら hot_events を呼ぶ。返ってくる順位は報道量（記事件数）などでコードが決定的に付けたものなので、その順序を入れ替えずに紹介し、各出来事に問いのタグ・記事数・対象期間（poolLatest）を添える。ランキングの回答では出来事の提示だけに留めること。個別の出来事の画面はチャットからは生成できない（そのためのツールは無い）。利用者が特定の出来事の画面を見たがったら、出来事ごとに表示される「画面を見る」ボタンを押すよう案内する。例として1件だけ選んで画面を出すようなことは決してしない。
- 回答は日本語で、結論から簡潔に。推測と事実を区別する。`;

// Tools never throw: an empty pool is a normal empty result, and any
// failure becomes a friendly structured result. Raw error text must not
// reach the screen. Inputs are parsed leniently (models pass numbers as
// strings, ids in upper case) and normalised here.
function normalizeQid(v: unknown): QuestionId | null {
  if (typeof v !== "string") return null;
  const lower = v.toLowerCase();
  return (QUESTION_IDS as readonly string[]).includes(lower) ? (lower as QuestionId) : null;
}

function normalizeInt(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : fallback;
}

const qidInput = z.string().describe("問いID（q1〜q6）");
const daysInput = z.union([z.number(), z.string()]).optional();
const limitInput = z.union([z.number(), z.string()]).optional();

function buildTools(env: Env) {
  return {
    pool_status: tool({
      description:
        "問いごとの収集プールの鮮度（frontier、累計、直近24h件数、欠落）を返す。探検の最初に必ず呼ぶ。",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return { questions: await poolStatus(env) };
        } catch (err) {
          console.error("pool_status failed", err);
          return { error: "プールの鮮度を取得できませんでした。" };
        }
      },
    }),
    search_articles: tool({
      description:
        "問いのプールから記事を検索する（タイトル部分一致のキーワード、期間、上限）。新しい順。該当が無ければ空の結果が返る（エラーではない）。",
      inputSchema: z.object({
        question_id: qidInput,
        keyword: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: limitInput,
      }),
      execute: async (args) => {
        const qid = normalizeQid(args.question_id);
        if (!qid) return { error: "問い（q1〜q6）を特定できませんでした。" };
        try {
          return {
            articles: await searchArticles(env, {
              questionId: qid,
              keyword: args.keyword,
              since: args.since,
              until: args.until,
              limit: normalizeInt(args.limit, 20),
            }),
          };
        } catch (err) {
          console.error("search_articles failed", err);
          return { error: "記事の検索に失敗しました。" };
        }
      },
    }),
    tone_trend: tool({
      description:
        "問いごとに日別の記事件数と平均toneを返す。プールが空の問いでは空の推移が返る（エラーではない）。",
      inputSchema: z.object({
        question_id: qidInput,
        days: daysInput,
      }),
      execute: async (args) => {
        const qid = normalizeQid(args.question_id);
        if (!qid) return { error: "問い（q1〜q6）を特定できませんでした。" };
        try {
          return {
            trend: await toneTrend(env, qid, normalizeInt(args.days, 30)),
          };
        } catch (err) {
          console.error("tone_trend failed", err);
          return { error: "トーン推移を取得できませんでした。" };
        }
      },
    }),
    get_baseline: tool({
      description: "問いの「現時点の見立て」（baseline全文）を返す。",
      inputSchema: z.object({ question_id: qidInput }),
      execute: async (args) => {
        const qid = normalizeQid(args.question_id);
        if (!qid) return { error: "問い（q1〜q6）を特定できませんでした。" };
        return { baseline: BASELINES[qid] ?? "" };
      },
    }),
    get_thread: tool({
      description: "問いの記録スレッドを返す（長い場合は末尾8000文字）。",
      inputSchema: z.object({ question_id: qidInput }),
      execute: async (args) => {
        const qid = normalizeQid(args.question_id);
        if (!qid) return { error: "問い（q1〜q6）を特定できませんでした。" };
        const full = THREADS[qid] ?? "";
        return {
          thread: full.length > 8000 ? "…（前略）\n" + full.slice(-8000) : full,
          truncated: full.length > 8000,
        };
      },
    }),
    list_views: tool({
      description:
        "自動生成された画面（Generative UI）の一覧を返す。新しい順。画面本体はアプリのチャット欄に描画される。",
      inputSchema: z.object({
        question_id: z.string().optional(),
      }),
      execute: async (args) => {
        try {
          const qid = args.question_id ? normalizeQid(args.question_id) : null;
          const rs = qid
            ? await env.DB.prepare(
                "SELECT id, question_id, title, article_count, verified, origin, created_at FROM generated_views WHERE question_id = ? ORDER BY id DESC LIMIT 20",
              )
                .bind(qid)
                .all()
            : await env.DB.prepare(
                "SELECT id, question_id, title, article_count, verified, origin, created_at FROM generated_views ORDER BY id DESC LIMIT 20",
              ).all();
          return { views: rs.results };
        } catch (err) {
          console.error("list_views failed", err);
          return { error: "生成済みの画面を取得できませんでした。" };
        }
      },
    }),
    hot_events: tool({
      description:
        "いま（収集プールの範囲で）世界のメディアで注目されている出来事を、注目度順に返す。順位は報道量（同じ出来事の記事件数）→媒体数→新しさでコードが決定的に付けたもので、入れ替えてはいけない。各出来事に cluster_key が付く。漠然と『何が注目されてる？』と聞かれたときに使う。",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          return await hotEvents(env);
        } catch (err) {
          console.error("hot_events failed", err);
          return { error: "注目の出来事を取得できませんでした。" };
        }
      },
    }),
    // NOTE: there is deliberately no "show one event" tool here. An
    // event's view is generated only when the user presses the
    // 「画面を見る」 button in a hot_events answer, which goes through
    // POST /api/threads/:id/event-view → appendEventView. When the model
    // had a callable tool for it, it would pick an example event on its
    // own initiative right after a ranking answer and generate its view
    // unasked — so the capability is withheld at the tool-definition
    // layer, not merely discouraged in the prompt.
    build_view: tool({
      description:
        "指定した問いの画面（ダッシュボード）をその場で生成する。プールの最新記事から部品（統計・記事カード・時系列・トーングラフ・媒体一覧・見立てパネル）を組み立て、生成済み画面として保存もする。全体像を見たいとき、出来事を画面で見たいときに使う。",
      inputSchema: z.object({
        question_id: qidInput,
        keyword: z.string().optional(),
      }),
      execute: async (args) => {
        const qid = normalizeQid(args.question_id);
        if (!qid) return { error: "問い（q1〜q6）を特定できませんでした。" };
        try {
          const articles = await searchArticles(env, {
            questionId: qid,
            keyword: args.keyword,
            limit: 30,
          });
          const status = (await poolStatus(env)).find((p) => p.questionId === qid);
          const withFetched = articles.map((a) => ({
            ...a,
            fetchedAt: a.seendate ?? "",
          }));
          const clusters = clusterArticles(withFetched);
          const cluster = clusters[0] ?? {
            key: "all",
            articles: withFetched,
            tokens: new Set<string>(),
          };
          const trend = await toneTrend(env, qid, 30).catch(() => []);
          const spec = materializeViewSpec({
            questionId: qid,
            generatedAt: new Date().toISOString(),
            origin: "chat",
            cluster,
            choice: fallbackChoice(cluster, QUESTION_LABELS[qid]),
            trend,
            pool: {
              total: status?.total ?? 0,
              frontier: status?.frontier ?? null,
              recent24h: status?.recent24h ?? 0,
            },
            baseline: BASELINES[qid] ?? "",
          });
          if (args.keyword) {
            spec.title = `${QUESTION_LABELS[qid]}：「${args.keyword}」の画面`;
          }
          const warnings = verifyViewSpec(spec, {
            articleUrls: new Set(withFetched.map((a) => a.url)),
            articles: withFetched,
          });
          const viewId = await saveView(
            env,
            qid,
            cluster.key,
            spec,
            withFetched.length,
            warnings,
            null,
          );
          return { viewId, view: spec, warnings };
        } catch (err) {
          console.error("build_view failed", err);
          return { error: "画面の生成に失敗しました。" };
        }
      },
    }),
  };
}

export class ExplorerAgent extends AIChatAgent<Env> {
  /** Keep the D1 thread index (sidebar) in step with this conversation:
   *  bump updated_at on every turn, and take the title from the first
   *  user message while the thread is still unnamed. Bookkeeping only —
   *  a failure here must never break the chat itself. */
  private async touchThreadRecord(): Promise<void> {
    try {
      const id = this.name;
      if (!id) return;
      const now = new Date().toISOString();
      await this.env.DB.prepare(
        "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?,?,?,?) " +
          "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
      )
        .bind(id, "新しいスレッド", now, now)
        .run();
      const userMessages = this.messages.filter((m) => m.role === "user");
      if (userMessages.length === 1) {
        const text = userMessages[0].parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text?: string }).text ?? "")
          .join("")
          .trim();
        if (text) {
          await this.env.DB.prepare(
            "UPDATE threads SET title = ? WHERE id = ? AND title = '新しいスレッド'",
          )
            .bind([...text].slice(0, 40).join(""), id)
            .run();
        }
      }
    } catch (err) {
      console.error("thread record update failed", err);
    }
  }

  /** RPC entry for POST /api/threads/:id/event-view — the ONLY path that
   *  generates an individual event's view, reached only when the user
   *  presses the event's 「画面を見る」 button. Appends the view to this
   *  thread as a single assistant message (no synthetic user turn: the
   *  history must not gain user-style messages nobody wrote), so the
   *  screen appears inside the conversation and survives reloads. The
   *  part type stays "tool-show_event" so the client renders it with the
   *  same component as before; it is a rendering label, not a callable
   *  tool — the chat model has no such tool. */
  async appendEventView(
    questionIdRaw: unknown,
    clusterKeyRaw: unknown,
  ): Promise<{ viewId: number } | { error: string }> {
    const qid = normalizeQid(questionIdRaw);
    if (!qid || typeof clusterKeyRaw !== "string" || !clusterKeyRaw) {
      return { error: "出来事を特定できませんでした。" };
    }
    let built: Awaited<ReturnType<typeof buildEventView>>;
    try {
      built = await buildEventView(this.env, qid, clusterKeyRaw);
    } catch (err) {
      console.error("appendEventView failed", err);
      return { error: "画面の生成に失敗しました。" };
    }
    if (!built) {
      return { error: "その出来事はプールの更新で見つからなくなりました。" };
    }
    const assistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [
        { type: "text", text: `「${built.spec.title}」の画面です。` },
        {
          type: "tool-show_event",
          toolCallId: crypto.randomUUID(),
          state: "output-available",
          input: { question_id: qid, cluster_key: clusterKeyRaw },
          output: { viewId: built.viewId, view: built.spec, warnings: built.warnings },
        },
      ],
    } as UIMessage;
    await this.persistMessages([...this.messages, assistantMessage]);
    await this.touchThreadRecord();
    return { viewId: built.viewId };
  }

  async onChatMessage(onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0]) {
    await this.touchThreadRecord();
    const ai = createAI({ binding: this.env.AI });
    const result = streamText({
      model: ai(MODEL_CHAT),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(this.messages),
      tools: buildTools(this.env),
      stopWhen: stepCountIs(6),
      onFinish: async (event) => {
        const usage = event.totalUsage;
        if (usage) {
          await recordNeurons(
            this.env,
            estimateNeurons(MODEL_CHAT, usage.inputTokens ?? 0, usage.outputTokens ?? 0),
          ).catch(() => undefined);
        }
        await onFinish(event as never);
      },
    });
    return result.toUIMessageStreamResponse();
  }

  /** Cron entry point (also callable from /api/check-now for verification).
   *  Broadcasts a notice to connected screens when new views were generated. */
  async runRadarCheck(): Promise<RadarCheckSummary> {
    const summary = await runRadarCheck(this.env);
    if (summary.newViews > 0) {
      this.broadcast(
        JSON.stringify({
          type: "radar-views",
          message: "新しい画面が生成されました",
          newViews: summary.newViews,
          viewIds: summary.viewIds,
          checkedAt: summary.checkedAt,
        }),
      );
    }
    return summary;
  }
}
