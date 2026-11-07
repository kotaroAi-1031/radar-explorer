import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent, useAgentToolEvents } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

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

interface Article {
  url: string;
  title: string | null;
  domain: string | null;
  seendate: string | null;
  tone: number | null;
  sourceCountry: string | null;
}

interface TrendPoint {
  day: string;
  count: number;
  avgTone: number | null;
}

interface Draft {
  id: number;
  question_id: string;
  headline: string;
  body: string;
  article_count: number;
  verified: number;
  warnings: string | null;
  status: string;
  model: string | null;
  created_at: string;
}

interface DraftBody {
  headline: string;
  what: string;
  sources: string[];
  impact: string;
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function formatSeendate(s: string | null): string {
  if (!s) return "—";
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC`;
}

function FreshnessBoard({ questions }: { questions: PoolEntry[] }) {
  return (
    <div className="board">
      {questions.map((q) => (
        <div key={q.questionId} className="board-row">
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

function ArticleCards({ articles }: { articles: Article[] }) {
  if (articles.length === 0)
    return <p className="empty">該当する記事はプールにありません。</p>;
  return (
    <div className="cards">
      {articles.map((a) => (
        <article key={a.url} className="card">
          <a href={a.url} target="_blank" rel="noreferrer">
            {a.title ?? "(タイトルなし)"}
          </a>
          <div className="card-meta">
            <span>{a.domain ?? "?"}</span>
            <span>{formatSeendate(a.seendate)}</span>
            {a.tone !== null && <span>tone {a.tone.toFixed(1)}</span>}
            {a.sourceCountry && <span>{a.sourceCountry}</span>}
          </div>
        </article>
      ))}
    </div>
  );
}

function ToneChart({ trend }: { trend: TrendPoint[] }) {
  if (trend.length === 0)
    return <p className="empty">トーン推移のデータがありません。</p>;
  const w = 560;
  const h = 150;
  const pad = 24;
  const maxCount = Math.max(...trend.map((t) => t.count), 1);
  const tones = trend
    .map((t) => t.avgTone)
    .filter((t): t is number => t !== null);
  const minTone = Math.min(...tones, -1);
  const maxTone = Math.max(...tones, 1);
  const x = (i: number) =>
    pad + (i * (w - pad * 2)) / Math.max(trend.length - 1, 1);
  const yCount = (c: number) => h - pad - (c / maxCount) * (h - pad * 2);
  const yTone = (t: number) =>
    h / 2 -
    ((t - (minTone + maxTone) / 2) / (maxTone - minTone || 1)) *
      (h - pad * 2) *
      0.8;
  const barW = Math.max((w - pad * 2) / trend.length - 2, 2);
  const tonePath = trend
    .map((t, i) => (t.avgTone === null ? null : `${x(i)},${yTone(t.avgTone)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label="日別件数と平均トーン"
      >
        <line
          x1={pad}
          y1={h / 2}
          x2={w - pad}
          y2={h / 2}
          className="chart-zero"
        />
        {trend.map((t, i) => (
          <rect
            key={t.day}
            x={x(i) - barW / 2}
            y={yCount(t.count)}
            width={barW}
            height={h - pad - yCount(t.count)}
            className="chart-bar"
          >
            <title>{`${t.day}: ${t.count}件, tone ${t.avgTone?.toFixed(2) ?? "—"}`}</title>
          </rect>
        ))}
        {tonePath && <polyline points={tonePath} className="chart-line" />}
      </svg>
      <figcaption>
        棒＝日別件数（最大 {maxCount}）、線＝平均トーン。
        {trend[0]?.day} 〜 {trend[trend.length - 1]?.day}
      </figcaption>
    </figure>
  );
}

function DraftCard({ draft }: { draft: Draft }) {
  let body: DraftBody | null = null;
  try {
    body = JSON.parse(draft.body) as DraftBody;
  } catch {
    body = null;
  }
  let warnings: string[] = [];
  try {
    warnings = draft.warnings ? (JSON.parse(draft.warnings) as string[]) : [];
  } catch {
    warnings = [];
  }
  return (
    <article className="card draft">
      <div className="card-meta">
        <span className="qid">{draft.question_id.toUpperCase()}</span>
        <span className={draft.verified ? "badge" : "badge badge-warn"}>
          {draft.verified ? "検証OK" : "要確認"}
        </span>
        <span>{draft.status}</span>
        <span>{draft.article_count} 件の記事から生成</span>
        <span>{new Date(draft.created_at).toLocaleString("ja-JP")}</span>
      </div>
      <h4>{draft.headline}</h4>
      {body ? (
        <>
          <p>{body.what}</p>
          <p className="impact">
            <strong>見立てへの影響：</strong>
            {body.impact}
          </p>
          <ul className="sources">
            {body.sources.map((s) => (
              <li key={s}>
                <a href={s} target="_blank" rel="noreferrer">
                  {s}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="empty">本文の解析に失敗しました。</p>
      )}
      {warnings.length > 0 && (
        <ul className="warnings">
          {warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </article>
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
  list_drafts: "下書き一覧を取得",
};

function ToolPart({ part }: { part: Record<string, unknown> }) {
  const type = String(part.type ?? "");
  const name = type.replace(/^tool-/, "");
  const state = String(part.state ?? "");
  const output = part.output as Record<string, unknown> | undefined;
  const label = TOOL_LABELS[name] ?? name;
  return (
    <div className="toolpart">
      <div className="step">
        <span
          className={
            state === "output-available"
              ? "step-dot done"
              : state === "output-error"
                ? "step-dot error"
                : "step-dot running"
          }
        />
        <span>
          {label}
          {state === "output-available"
            ? "（完了）"
            : state === "output-error"
              ? "（エラー）"
              : "（実行中…）"}
        </span>
      </div>
      {state === "output-available" && output && (
        <div className="tool-output">
          {name === "pool_status" && Array.isArray(output.questions) && (
            <FreshnessBoard questions={output.questions as PoolEntry[]} />
          )}
          {name === "search_articles" && Array.isArray(output.articles) && (
            <ArticleCards articles={output.articles as Article[]} />
          )}
          {name === "tone_trend" && Array.isArray(output.trend) && (
            <ToneChart trend={output.trend as TrendPoint[]} />
          )}
          {name === "get_baseline" && typeof output.baseline === "string" && (
            <details>
              <summary>現時点の見立て（全文）</summary>
              <pre>{output.baseline}</pre>
            </details>
          )}
          {name === "get_thread" && typeof output.thread === "string" && (
            <details>
              <summary>記録スレッド</summary>
              <pre>{output.thread}</pre>
            </details>
          )}
          {name === "list_drafts" && Array.isArray(output.drafts) && (
            <div className="cards">
              {(output.drafts as Draft[]).map((d) => (
                <DraftCard key={d.id} draft={d} />
              ))}
            </div>
          )}
        </div>
      )}
      {state === "output-error" && (
        <p className="empty">
          {String(part.errorText ?? "エラーが発生しました")}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: string;
  parts: Record<string, unknown>[];
}

export function App() {
  const [questions, setQuestions] = useState<PoolEntry[]>([]);
  const [neurons, setNeurons] = useState<number>(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
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

  const loadDrafts = useCallback(async () => {
    const res = await fetch("/api/drafts");
    if (res.ok) {
      const data = (await res.json()) as { drafts: Draft[] };
      setDrafts(data.drafts);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadDrafts();
  }, [loadStatus, loadDrafts]);

  const agent = useAgent({
    agent: "explorer-agent",
    name: "main",
    onMessage: (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as { type?: string };
        if (data.type === "radar-drafts") {
          setNotice(
            "新しい下書きができました。下書きパネルを確認してください。",
          );
          void loadDrafts();
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
  } = useAgentChat({ agent });
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
        const summary = (await res.json()) as { newDrafts: number };
        setNotice(
          summary.newDrafts > 0
            ? `チェック完了：新しい下書きが ${summary.newDrafts} 件できました。`
            : "チェック完了：新しい下書きはありませんでした。",
        );
        await Promise.all([loadDrafts(), loadStatus()]);
      }
    } finally {
      setChecking(false);
    }
  }, [loadDrafts, loadStatus]);

  return (
    <div className="app">
      <header>
        <h1>一次情報レーダー 探検UI</h1>
        <p className="sub">
          収集プールを出典つきの部品で探索する。現在のプールはバックフィル中で、表示される
          frontier がプールの最先端です。
        </p>
        <div className="header-nums">
          <span>
            本日の neurons 使用量（概算）:{" "}
            {Math.round(neurons).toLocaleString()} / 10,000
          </span>
          <button
            type="button"
            onClick={() => void checkNow()}
            disabled={checking}
          >
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
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
      )}

      <main>
        <section className="panel">
          <h2>プールの鮮度</h2>
          {questions.length > 0 ? (
            <FreshnessBoard questions={questions} />
          ) : (
            <p className="empty">読み込み中…</p>
          )}
          <h2>自動生成の下書き（承認待ち）</h2>
          {drafts.length > 0 ? (
            <div className="cards">
              {drafts.map((d) => (
                <DraftCard key={d.id} draft={d} />
              ))}
            </div>
          ) : (
            <p className="empty">
              まだ下書きはありません。新着が閾値を超えると15分おきのチェックで自動生成されます。
            </p>
          )}
        </section>

        <section className="panel chat">
          <h2>探検チャット</h2>
          {agentRuns.length > 0 && (
            <p className="empty">エージェント実行中: {agentRuns.length} 件</p>
          )}
          <div className="messages">
            {messages.length === 0 && (
              <div className="hint">
                <p>例えば：</p>
                <ul>
                  <li>「プールの鮮度は？」</li>
                  <li>「問い5で最近の記事を見せて」</li>
                  <li>「問い1のトーン推移は？」</li>
                  <li>「問い3の見立てと最近の記録は？」</li>
                </ul>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="msg-role">
                  {m.role === "user" ? "あなた" : "案内役"}
                </div>
                {m.parts.map((part, i) => {
                  const p = part as unknown as Record<string, unknown>;
                  if (p.type === "text") {
                    return (
                      <p key={i} className="msg-text">
                        {String(p.text ?? "")}
                      </p>
                    );
                  }
                  if (
                    typeof p.type === "string" &&
                    p.type.startsWith("tool-")
                  ) {
                    return <ToolPart key={i} part={p} />;
                  }
                  return null;
                })}
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
            />
            <button
              type="submit"
              disabled={status === "submitted" || status === "streaming"}
            >
              {status === "submitted" || status === "streaming"
                ? "応答中…"
                : "送信"}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
