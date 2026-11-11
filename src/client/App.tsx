import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Streamdown } from "streamdown";
import type { ViewSpec } from "../views";
import { ArticleCards, ViewRenderer } from "./ViewRenderer";
import { formatIsoDay, formatSeendate } from "./format";
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

interface ThreadInfo {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface HotEventItem {
  questionId: string;
  questionLabel: string;
  clusterKey: string;
  title: string | null;
  articleCount: number;
  domainCount: number;
  latestSeendate: string | null;
}

interface ChatMessage {
  id: string;
  role: string;
  parts: Record<string, unknown>[];
}

type OpenEventFn = (questionId: string, clusterKey: string) => void;

// ---------------------------------------------------------------------------
// Freshness board (rendered only as a pool_status tool answer in chat)
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
// Tool output rendering inside chat messages.
// Only the output (the answer components) is rendered — no execution
// steps, no raw inputs, no raw errors.
// ---------------------------------------------------------------------------

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

function MediaBreakdownOutput({ output }: { output: Record<string, unknown> }) {
  if (typeof output.total !== "number" || !Array.isArray(output.top)) return null;
  const top = output.top as { domain: string; count: number; share: number }[];
  if (output.total === 0 || top.length === 0) {
    return <p className="empty">プールにはまだ記事がありません。</p>;
  }
  const domainCount = typeof output.domainCount === "number" ? output.domainCount : top.length;
  return (
    <div className="media-breakdown">
      <p className="hot-caption">
        累計 {output.total.toLocaleString()} 件・媒体 {domainCount} 種類。多い媒体から順に、
        件数と全体に占める割合です。
      </p>
      <ul className="source-list">
        {top.map((m) => (
          <li key={m.domain}>
            <span>{m.domain}</span>
            <span className="source-count">
              {m.count} 件（{Math.round(m.share * 100)}%）
            </span>
          </li>
        ))}
      </ul>
    </div>
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
  const views = output.views as { id: number; title: string }[];
  if (views.length === 0) {
    return <p className="empty">生成された画面はまだありません。</p>;
  }
  return (
    <ul className="view-rows">
      {views.map((v) => (
        <li key={v.id}>{v.title}</li>
      ))}
    </ul>
  );
}

function BuildViewOutput({ output }: { output: Record<string, unknown> }) {
  if (output.view == null) return null;
  return <ViewRenderer spec={output.view as ViewSpec} />;
}

function HotEventsOutput({
  output,
  onOpenEvent,
  pendingKey,
}: {
  output: Record<string, unknown>;
  onOpenEvent: OpenEventFn;
  pendingKey: string | null;
}) {
  if (!Array.isArray(output.events)) return null;
  const events = output.events as HotEventItem[];
  const poolLatest = typeof output.poolLatest === "string" ? output.poolLatest : null;
  if (events.length === 0) {
    return <p className="empty">プールにはまだ、出来事としてまとまる記事がありません。</p>;
  }
  return (
    <div className="hot-events">
      <p className="hot-caption">
        収集プールの最新（{formatIsoDay(poolLatest)}
        ）時点での注目度順です。報道量（同じ出来事の記事件数）の多い順に並んでいます。
      </p>
      <ol className="event-list">
        {events.map((e, i) => (
          <li
            key={`${e.questionId}:${e.clusterKey}`}
            className="event-row rise"
            style={{ "--i": i } as React.CSSProperties}
          >
            <span className="event-rank">{i + 1}</span>
            <div className="event-body">
              <span className="event-title">{e.title ?? "(タイトルなし)"}</span>
              <span className="event-meta">
                <span className="qid">{e.questionId.toUpperCase()}</span>
                {e.articleCount} 件・{e.domainCount} 媒体・最新 {formatSeendate(e.latestSeendate)}
              </span>
            </div>
            <button
              type="button"
              className="event-open"
              disabled={pendingKey !== null}
              onClick={() => onOpenEvent(e.questionId, e.clusterKey)}
            >
              {pendingKey === e.clusterKey ? "生成中…" : "画面を見る"}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ToolOutput({
  name,
  output,
  onOpenEvent,
  pendingKey,
}: {
  name: string;
  output: Record<string, unknown>;
  onOpenEvent: OpenEventFn;
  pendingKey: string | null;
}) {
  switch (name) {
    case "pool_status":
      return <PoolStatusOutput output={output} />;
    case "search_articles":
      return <SearchOutput output={output} />;
    case "media_breakdown":
      return <MediaBreakdownOutput output={output} />;
    case "tone_trend":
      return <TrendOutput output={output} />;
    case "get_baseline":
      return <DocOutput output={output} field="baseline" summary="現時点の見立て（全文）" />;
    case "get_thread":
      return <DocOutput output={output} field="thread" summary="記録スレッド" />;
    case "list_views":
      return <ListViewsOutput output={output} />;
    case "build_view":
    case "show_event":
      return <BuildViewOutput output={output} />;
    case "hot_events":
      return <HotEventsOutput output={output} onOpenEvent={onOpenEvent} pendingKey={pendingKey} />;
    default:
      return null;
  }
}

function ToolPart({
  part,
  onOpenEvent,
  pendingKey,
}: {
  part: Record<string, unknown>;
  onOpenEvent: OpenEventFn;
  pendingKey: string | null;
}) {
  const type = String(part.type ?? "");
  const name = type.replace(/^tool-/, "");
  const state = String(part.state ?? "");
  const output = part.output as Record<string, unknown> | undefined;
  if (state === "output-available" && output) {
    return (
      <div className="toolpart">
        {typeof output.error === "string" ? (
          <p className="empty">{output.error}</p>
        ) : (
          <ToolOutput
            name={name}
            output={output}
            onOpenEvent={onOpenEvent}
            pendingKey={pendingKey}
          />
        )}
      </div>
    );
  }
  if (state === "output-error") {
    return (
      <div className="toolpart">
        <p className="empty">データを取得できませんでした。時間をおいてもう一度お試しください。</p>
      </div>
    );
  }
  return null;
}

// Message parts are append-only within a message, so a per-type ordinal
// is a stable identity (tool parts prefer their toolCallId).
function MessageParts({
  message,
  onOpenEvent,
  pendingKey,
}: {
  message: ChatMessage;
  onOpenEvent: OpenEventFn;
  pendingKey: string | null;
}) {
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
          return (
            <ToolPart key={key} part={part} onOpenEvent={onOpenEvent} pendingKey={pendingKey} />
          );
        }
        return null;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Chat panel: one thread = one agent instance. Remounted per thread
// (keyed by thread id in App), so switching threads reloads its history.
// The initial state is just the message area (empty) and the composer —
// nothing is pre-rendered before the user asks. Connecting only replays
// the stored history (read-only): no model call, no new message. A turn
// starts solely from the composer's submit (or the explicit
// 「画面を見る」 button for an event view).
// ---------------------------------------------------------------------------

function ChatPanel({
  threadId,
  onViewsChanged,
  onThreadsChanged,
}: {
  threadId: string;
  onViewsChanged: () => void;
  onThreadsChanged: () => void;
}) {
  const [input, setInput] = useState("");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const agent = useAgent({
    agent: "explorer-agent",
    name: threadId,
    onMessage: (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as { type?: string };
        if (data.type === "radar-views") {
          onViewsChanged();
        }
      } catch {
        // not one of ours — the chat protocol handles it
      }
    },
  });

  const {
    messages: rawMessages,
    sendMessage,
    status,
    error,
  } = useAgentChat({
    agent,
  });
  const messages = rawMessages as unknown as ChatMessage[];

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const wasBusy = useRef(false);
  useEffect(() => {
    const busy = status === "submitted" || status === "streaming";
    if (wasBusy.current && !busy) {
      onThreadsChanged();
    }
    wasBusy.current = busy;
  }, [status, onThreadsChanged]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || status === "submitted" || status === "streaming") return;
    setInput("");
    void sendMessage({ text });
  }, [input, sendMessage, status]);

  const openEvent = useCallback<OpenEventFn>(
    (questionId, clusterKey) => {
      // One generation at a time: while a request is in flight every
      // event button is disabled (see HotEventsOutput); this guard
      // covers repeats that bypass the button state.
      if (pendingKey !== null) return;
      setPendingKey(clusterKey);
      setEventError(null);
      void (async () => {
        try {
          const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/event-view`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ questionId, clusterKey }),
          });
          const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
          if (!res.ok) {
            setEventError(
              typeof data?.error === "string" ? data.error : "画面の生成に失敗しました。",
            );
            return;
          }
          // The view was appended server-side: refresh the sidebar's
          // view list and this thread's updated-at too.
          onViewsChanged();
          onThreadsChanged();
        } catch {
          setEventError("画面の生成に失敗しました。通信状態を確認してもう一度お試しください。");
        } finally {
          setPendingKey(null);
        }
      })();
    },
    [threadId, pendingKey, onViewsChanged, onThreadsChanged],
  );

  return (
    <div className="chat">
      <div className="messages">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="msg-role">{m.role === "user" ? "あなた" : "案内役"}</div>
            {<MessageParts message={m} onOpenEvent={openEvent} pendingKey={pendingKey} />}
          </div>
        ))}
        {status === "submitted" && (
          <p className="empty" role="status">
            案内役が応答を準備しています…
          </p>
        )}
        {(status === "error" || error != null) && (
          <p className="empty" role="alert">
            応答の取得に失敗しました。時間をおいてもう一度お試しください。
          </p>
        )}
        {eventError && (
          <p className="empty" role="alert">
            {eventError}
          </p>
        )}
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
          placeholder="質問する（Enterで送信、Shift+Enterで改行）"
          rows={2}
          aria-label="質問入力"
        />
        <button type="submit" disabled={status === "submitted" || status === "streaming"}>
          {status === "submitted" || status === "streaming" ? "応答中…" : "送信"}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only overlay for one auto-generated view (native <dialog>).
// ---------------------------------------------------------------------------

function ViewOverlay({ view, onClose }: { view: GeneratedView; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);
  return (
    <dialog ref={ref} className="view-dialog" aria-label={view.title} onClose={onClose}>
      <button type="button" className="overlay-close" onClick={onClose} aria-label="閉じる">
        ×
      </button>
      <ViewRenderer spec={view.spec} />
      {view.verified === 0 && (
        <p className="warnings-note">
          ⚠ この画面には検証ゲートの警告があります（出典・数値を要確認）。
        </p>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// App shell: thread list sidebar + the chat. Auto-generated views live in
// a collapsed disclosure at the bottom of the sidebar and open in a
// read-only overlay — they are never part of the initial screen.
// ---------------------------------------------------------------------------

const ACTIVE_THREAD_KEY = "radar-explorer:active-thread";

export function App() {
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [views, setViews] = useState<GeneratedView[]>([]);
  const [openView, setOpenView] = useState<GeneratedView | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  const loadThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/threads");
      if (res.ok) {
        const data = (await res.json()) as { threads: ThreadInfo[] };
        setThreads(data.threads);
        return data.threads;
      }
    } catch {
      // Network failure: keep showing the current list instead of
      // surfacing an unhandled rejection; a later load can recover.
    }
    return null;
  }, []);

  const loadViews = useCallback(async () => {
    try {
      const res = await fetch("/api/views");
      if (res.ok) {
        const data = (await res.json()) as { views: GeneratedView[] };
        setViews(data.views);
      }
    } catch {
      // Same as loadThreads: a failed refresh keeps the current list.
    }
  }, []);

  // Duplicate-creation guard, two layers: the ref blocks a second call
  // while a create request is in flight (double-clicks, key repeats),
  // and the `creating` state disables the button for the same window so
  // the block is also visible.
  const createThread = useCallback(async () => {
    if (creatingRef.current) return null;
    creatingRef.current = true;
    setCreating(true);
    try {
      const res = await fetch("/api/threads", { method: "POST" });
      if (!res.ok) return null;
      const data = (await res.json()) as { thread: ThreadInfo };
      setThreads((prev) => [data.thread, ...prev.filter((t) => t.id !== data.thread.id)]);
      return data.thread;
    } catch {
      return null;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const list = await loadThreads();
      void loadViews();
      const stored = localStorage.getItem(ACTIVE_THREAD_KEY);
      // Opening the app is strictly read-only: it never creates a
      // thread (or anything else). Threads are created only by the
      // ＋ 新しいスレッド button; generation happens only when the
      // user types a question and sends it.
      if (list && list.length > 0) {
        setActiveId(stored && list.some((t) => t.id === stored) ? stored : list[0].id);
      } else {
        setActiveId(stored ?? "main");
      }
    })();
  }, [loadThreads, loadViews]);

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_THREAD_KEY, activeId);
  }, [activeId]);

  const startNewThread = useCallback(async () => {
    const created = await createThread();
    if (created) setActiveId(created.id);
  }, [createThread]);

  const refreshThreads = useCallback(() => {
    void loadThreads();
  }, [loadThreads]);

  const refreshViews = useCallback(() => {
    void loadViews();
  }, [loadViews]);

  return (
    <div className="app">
      <div className="layout">
        <aside className="sidebar">
          <div className="side-head">
            <p className="eyebrow">PRIMARY SOURCE RADAR</p>
            <h1>一次情報レーダー 探検UI</h1>
          </div>
          <button
            type="button"
            className="new-thread"
            onClick={() => void startNewThread()}
            disabled={creating}
          >
            {creating ? "作成中…" : "＋ 新しいスレッド"}
          </button>
          <nav className="thread-list" aria-label="スレッド一覧">
            {threads.map((t) => (
              <button
                key={t.id}
                type="button"
                className={t.id === activeId ? "thread-item active" : "thread-item"}
                onClick={() => setActiveId(t.id)}
              >
                <span className="thread-title">{t.title}</span>
                <span className="thread-meta">
                  最終更新 {new Date(t.updated_at).toLocaleString("ja-JP")}
                </span>
              </button>
            ))}
          </nav>
          <details
            className="auto-views"
            onToggle={(e) => {
              if ((e.target as HTMLDetailsElement).open) void loadViews();
            }}
          >
            <summary>自動生成された画面（{views.length}）</summary>
            {views.length > 0 ? (
              <ul className="view-list">
                {views.map((v) => (
                  <li key={v.id}>
                    <button type="button" className="view-list-item" onClick={() => setOpenView(v)}>
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
                まだ画面はありません。新着がたまると1時間に1回のチェックで自動生成されます。
              </p>
            )}
          </details>
        </aside>

        <section className="panel chat-panel">
          {activeId && (
            <ChatPanel
              key={activeId}
              threadId={activeId}
              onViewsChanged={refreshViews}
              onThreadsChanged={refreshThreads}
            />
          )}
        </section>
      </div>

      {openView && <ViewOverlay view={openView} onClose={() => setOpenView(null)} />}
    </div>
  );
}
