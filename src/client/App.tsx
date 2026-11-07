import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent, useAgentToolEvents } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Streamdown } from "streamdown";
import { Tabs } from "@base-ui/react/tabs";
import type { ViewSpec } from "../views";
import { ArticleCards, ViewRenderer } from "./ViewRenderer";
import { formatSeendate } from "./format";
import { ToneChart } from "./ToneChart";

// ---------------------------------------------------------------------------
// Types (mirror the Worker-side shapes)
// ---------------------------------------------------------------------------

interface PoolEntry {
  questionId: string;
  label: string;
  total: number;
  frontier: string | null;
  frontierIso: string | null;
  recent24h: number;
  missing: boolean;
}

interface GeneratedView {
  id: number;
  question_id: string;
  title: string;
  spec: ViewSpec;
  article_count: number;
  verified: number;
  warnings: string | null;
  origin: string;
  created_at: string;
}

interface ChatMessage {
  id: string;
  role: string;
  parts: Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Freshness board
// ---------------------------------------------------------------------------

function FreshnessBoard({ questions }: { questions: PoolEntry[] }) {
  return (
    <div className="board">
      {questions.map((q, i) => (
        <div
          key={q.questionId}
          className="board-row rise"
          style={{ "--i": i } as React.CSSProperties}
        >
          <div className="board-head">
            <span className="qid">{q.questionId.toUpperCase()}</span>
            <span className={q.missing ? "badge badge-missing" : "badge"}>
              {q.missing ? "欠落" : "収集中"}
            </span>
          </div>
          <div className="board-label">{q.label}</div>
          <div className="board-nums">
            <span>
              最先端 <strong>{formatSeendate(q.frontier)}</strong>
            </span>
            <span>
              累計 <strong>{q.total.toLocaleString()}</strong> 件
            </span>
            <span>
              直近24h <strong>{q.recent24h}</strong> 件
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool output rendering inside chat messages
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  pool_status: "プールの鮮度を確認",
  search_articles: "記事を検索",
  tone_trend: "トーン推移を取得",
  get_baseline: "現時点の見立てを読む",
  get_thread: "記録スレッドを読む",
  list_views: "生成済みの画面を確認",
  build_view: "画面を生成",
};

function PoolStatusOutput({ output }: { output: Record<string, unknown> }) {
  if (!Array.isArray(output.questions)) return null;
  return <FreshnessBoard questions={output.questions as PoolEntry[]} />;
}

function SearchOutput({ output }: { output: Record<string, unknown> }) {
  if (!Array.isArray(output.articles)) return null;
  return (
    <ArticleCards
      articles={
        output.articles as {
          url: string;
          title: string | null;
          domain: string | null;
          seendate: string | null;
          tone: number | null;
          sourceCountry?: string | null;
        }[]
      }
    />
  );
}

function TrendOutput({ output }: { output: Record<string, unknown> }) {
  if (!Array.isArray(output.trend)) return null;
  return (
    <ToneChart trend={output.trend as { day: string; count: number; avgTone: number | null }[]} />
  );
}

function DocOutput({
  output,
  field,
  summary,
}: {
  output: Record<string, unknown>;
  field: "baseline" | "thread";
  summary: string;
}) {
  const text = output[field];
  if (typeof text !== "string") return null;
  return (
    <details>
      <summary>{summary}</summary>
      <pre>{text}</pre>
    </details>
  );
}

function ListViewsOutput({ output }: { output: Record<string, unknown> }) {
  if (!Array.isArray(output.views)) return null;
  return (
    <ul className="view-rows">
      {(output.views as { id: number; title: string }[]).map((v) => (
        <li key={v.id}>{v.title}</li>
      ))}
    </ul>
  );
}

function BuildViewOutput({ output }: { output: Record<string, unknown> }) {
  if (output.view == null) return null;
  return <ViewRenderer spec={output.view as ViewSpec} />;
}

function ToolOutput({ name, output }: { name: string; output: Record<string, unknown> }) {
  switch (name) {
    case "pool_status":
      return <PoolStatusOutput output={output} />;
    case "search_articles":
      return <SearchOutput output={output} />;
    case "tone_trend":
      return <TrendOutput output={output} />;
    case "get_baseline":
      return <DocOutput output={output} field="baseline" summary="現時点の見立て（全文）" />;
    case "get_thread":
      return <DocOutput output={output} field="thread" summary="記録スレッド" />;
    case "list_views":
      return <ListViewsOutput output={output} />;
    case "build_view":
      return <BuildViewOutput output={output} />;
    default:
      return null;
  }
}

function stepMeta(state: string): { dot: string; suffix: string } {
  if (state === "output-available") return { dot: "step-dot done", suffix: "（完了）" };
  if (state === "output-error") return { dot: "step-dot error", suffix: "（エラー）" };
  return { dot: "step-dot running", suffix: "（実行中…）" };
}

function ToolPart({ part }: { part: Record<string, unknown> }) {
  const type = String(part.type ?? "");
  const name = type.replace(/^tool-/, "");
  const state = String(part.state ?? "");
  const output = part.output as Record<string, unknown> | undefined;
  const input = part.input as Record<string, unknown> | undefined;
  const label = TOOL_LABELS[name] ?? name;
  const running = state !== "output-available" && state !== "output-error";
  const meta = stepMeta(state);
  return (
    <div className="toolpart">
      <div className="step">
        <span className={meta.dot} />
        <span>
          {label}
          {meta.suffix}
        </span>
      </div>
      {running && input && Object.keys(input).length > 0 && (
        <code className="tool-input">{JSON.stringify(input)}</code>
      )}
      {running && <div className="skeleton" aria-hidden="true" />}
      {state === "output-available" && output && (
        <div className="tool-output">
          {typeof output.error === "string" ? (
            <p className="empty">{output.error}</p>
          ) : (
            <ToolOutput name={name} output={output} />
          )}
        </div>
      )}
      {state === "output-error" && (
        <p className="empty">データを取得できませんでした。時間をおいてもう一度お試しください。</p>
      )}
    </div>
  );
}

// Message parts are append-only within a message, so a per-type ordinal
// is a stable identity (tool parts prefer their toolCallId).
function MessageParts({ message }: { message: ChatMessage }) {
  const counters = new Map<string, number>();
  const keyed = message.parts.map((part) => {
    const type = String(part.type ?? "part");
    const n = counters.get(type) ?? 0;
    counters.set(type, n + 1);
    const callId = typeof part.toolCallId === "string" ? part.toolCallId : null;
    return { part, key: callId ?? `${message.id}:${type}#${n}` };
  });
  return (
    <>
      {keyed.map(({ part, key }) => {
        if (part.type === "text") {
          const text = String(part.text ?? "");
          return message.role === "assistant" ? (
            <div key={key} className="md">
              <Streamdown>{text}</Streamdown>
            </div>
          ) : (
            <p key={key} className="msg-text">
              {text}
            </p>
          );
        }
        if (typeof part.type === "string" && part.type.startsWith("tool-")) {
          return <ToolPart key={key} part={part} />;
        }
        return null;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const [questions, setQuestions] = useState<PoolEntry[]>([]);
  const [neurons, setNeurons] = useState<number>(0);
  const [views, setViews] = useState<GeneratedView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [openViewId, setOpenViewId] = useState<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(async () => {
    const res = await fetch("/api/status");
    if (res.ok) {
      const data = (await res.json()) as {
        questions: PoolEntry[];
        neuronsUsedToday: number;
      };
      setQuestions(data.questions);
      setNeurons(data.neuronsUsedToday);
    }
  }, []);

  const loadViews = useCallback(async () => {
    const res = await fetch("/api/views");
    if (res.ok) {
      const data = (await res.json()) as { views: GeneratedView[] };
      setViews(data.views);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadViews();
  }, [loadStatus, loadViews]);

  const agent = useAgent({
    agent: "explorer-agent",
    name: "main",
    onMessage: (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as { type?: string };
        if (data.type === "radar-views") {
          setNotice("新しい画面が生成されました。");
          setOpenViewId(null);
          void loadViews();
          void loadStatus();
        }
      } catch {
        // not one of ours — the chat protocol handles it
      }
    },
  });

  const toolEvents = useAgentToolEvents({ agent });
  const agentRuns = Object.values(toolEvents.runsById);

  const {
    messages: rawMessages,
    sendMessage,
    status,
  } = useAgentChat({
    agent,
  });
  const messages = rawMessages as unknown as ChatMessage[];

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || status === "submitted" || status === "streaming") return;
    setInput("");
    void sendMessage({ text });
  }, [input, sendMessage, status]);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/check-now", { method: "POST" });
      if (res.ok) {
        const summary = (await res.json()) as { newViews: number };
        setNotice(
          summary.newViews > 0
            ? `チェック完了：新しい画面が ${summary.newViews} 件生成されました。`
            : "チェック完了：新しい画面はありませんでした。",
        );
        await Promise.all([loadViews(), loadStatus()]);
      }
    } finally {
      setChecking(false);
    }
  }, [loadViews, loadStatus]);

  const expandedView = views.find((v) => v.id === openViewId) ?? views[0];

  return (
    <div className="app">
      <header>
        <p className="eyebrow">PRIMARY SOURCE RADAR</p>
        <h1>一次情報レーダー 探検UI</h1>
        <p className="sub">
          収集プールを出典つきの部品で探索する。レーダーが更新されると、その出来事の画面がここに自動で生成されます。プールは現在バックフィル中で、frontier
          がプールの最先端です。
        </p>
        <div className="header-nums">
          <meter
            className="neuron-meter"
            aria-label="本日の neurons 使用量"
            min={0}
            max={10000}
            value={Math.round(neurons)}
          />
          <span>neurons {Math.round(neurons).toLocaleString()} / 10,000（本日・概算）</span>
          <button type="button" onClick={() => void checkNow()} disabled={checking}>
            {checking ? "チェック中…" : "今すぐ新着チェック"}
          </button>
          <button type="button" onClick={() => void loadStatus()}>
            鮮度を再読込
          </button>
        </div>
      </header>

      {notice && (
        <div className="notice" role="status">
          {notice}
          <button type="button" onClick={() => setNotice(null)} aria-label="閉じる">
            ×
          </button>
        </div>
      )}

      <main>
        <section className="panel">
          <Tabs.Root defaultValue="fresh">
            <Tabs.List aria-label="サイドパネル">
              <Tabs.Tab value="fresh">プールの鮮度</Tabs.Tab>
              <Tabs.Tab value="views">生成された画面（{views.length}）</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="fresh">
              {questions.length > 0 ? (
                <FreshnessBoard questions={questions} />
              ) : (
                <p className="empty">読み込み中…</p>
              )}
            </Tabs.Panel>
            <Tabs.Panel value="views">
              {views.length > 0 ? (
                <ul className="view-list">
                  {views.map((v) => (
                    <li key={v.id}>
                      <button
                        type="button"
                        className={
                          expandedView?.id === v.id ? "view-list-item active" : "view-list-item"
                        }
                        onClick={() => setOpenViewId(v.id)}
                      >
                        <span className="qid">{v.question_id.toUpperCase()}</span>
                        <span className="view-list-title">{v.title}</span>
                        <span className="view-list-meta">
                          {v.origin === "cron" ? "自動生成" : "チャット生成"}・
                          {new Date(v.created_at).toLocaleString("ja-JP")}
                          {v.verified ? "" : "・要確認"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">
                  まだ画面はありません。新着が閾値を超えると1時間に1回のチェックで自動生成されます。
                </p>
              )}
            </Tabs.Panel>
          </Tabs.Root>
        </section>

        <section className="panel chat">
          <h2>探検チャット</h2>
          {agentRuns.length > 0 && (
            <p className="empty">エージェント実行中: {agentRuns.length} 件</p>
          )}

          {expandedView && (
            <div className="feed-view">
              <p className="eyebrow">生成済みUI{openViewId ? "（選択中）" : "（最新）"}</p>
              <ViewRenderer key={expandedView.id} spec={expandedView.spec} />
              {expandedView.verified === 0 && (
                <p className="warnings-note">
                  ⚠ この画面には検証ゲートの警告があります（出典・数値を要確認）。
                </p>
              )}
            </div>
          )}

          <div className="messages">
            {messages.length === 0 && (
              <div className="hint">
                <p>例えば：</p>
                <ul>
                  <li>「プールの鮮度は？」</li>
                  <li>「問い5の画面を作って」</li>
                  <li>「問い1のトーン推移は？」</li>
                  <li>「問い3の見立てと最近の記録は？」</li>
                </ul>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="msg-role">{m.role === "user" ? "あなた" : "案内役"}</div>
                {<MessageParts message={m} />}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // IME-safe Enter submit (Modern Web Guidance)
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="問いについて質問する（Enterで送信、Shift+Enterで改行）"
              rows={2}
              aria-label="質問入力"
            />
            <button type="submit" disabled={status === "submitted" || status === "streaming"}>
              {status === "submitted" || status === "streaming" ? "応答中…" : "送信"}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
