import type { ViewSection, ViewSpec } from "../views";
import type { ArticleRef } from "../views";
import { ToneChart } from "./ToneChart";
import { formatSeendate } from "./format";

export function ArticleCards({
  articles,
}: {
  articles: {
    url: string;
    title: string | null;
    domain: string | null;
    seendate: string | null;
    tone: number | null;
    sourceCountry?: string | null;
  }[];
}) {
  if (articles.length === 0) return <p className="empty">該当する記事はプールにありません。</p>;
  return (
    <div className="cards">
      {articles.map((a, i) => (
        <article key={a.url} className="card rise" style={{ "--i": i } as React.CSSProperties}>
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

function Timeline({ articles }: { articles: ArticleRef[] }) {
  if (articles.length === 0) return <p className="empty">時系列にできる記事がありません。</p>;
  return (
    <ol className="timeline">
      {articles.map((a) => (
        <li key={a.url}>
          <time>{formatSeendate(a.seendate)}</time>
          <a href={a.url} target="_blank" rel="noreferrer">
            {a.title ?? "(タイトルなし)"}
          </a>
          <span className="tl-domain">{a.domain ?? ""}</span>
        </li>
      ))}
    </ol>
  );
}

function Section({ section }: { section: ViewSection }) {
  return (
    <section className="view-section">
      {section.heading && <h5>{section.heading}</h5>}
      {section.type === "summary" && <p className="view-summary">{section.text}</p>}
      {section.type === "assessment" && (
        <div className="assessment">
          {section.text && <p>{section.text}</p>}
          <details>
            <summary>現時点の見立て（抜粋）</summary>
            <pre>{section.baselineExcerpt}</pre>
          </details>
        </div>
      )}
      {section.type === "article_cards" && <ArticleCards articles={section.articles} />}
      {section.type === "timeline" && <Timeline articles={section.articles} />}
      {section.type === "tone_chart" && <ToneChart trend={section.trend} />}
      {section.type === "source_list" &&
        (section.sources.length === 0 ? (
          <p className="empty">報じた媒体の情報がありません。</p>
        ) : (
          <ul className="source-list">
            {section.sources.map((s) => (
              <li key={s.domain}>
                <a href={s.sampleUrl} target="_blank" rel="noreferrer">
                  {s.domain}
                </a>
                <span className="source-count">{s.count} 件</span>
              </li>
            ))}
          </ul>
        ))}
      {section.type === "stat_row" && (
        <div className="stat-row">
          <div className="stat">
            <span className="stat-num">{section.stats.total.toLocaleString()}</span>
            <span className="stat-label">プール累計</span>
          </div>
          <div className="stat">
            <span className="stat-num">{section.stats.clusterSize}</span>
            <span className="stat-label">この出来事の記事</span>
          </div>
          <div className="stat">
            <span className="stat-num">{section.stats.domains}</span>
            <span className="stat-label">報じた媒体</span>
          </div>
          <div className="stat">
            <span className="stat-num">{section.stats.recent24h}</span>
            <span className="stat-label">直近24hの新着</span>
          </div>
          <div className="stat">
            <span className="stat-num stat-num-small">
              {formatSeendate(section.stats.frontier)}
            </span>
            <span className="stat-label">プールの最先端</span>
          </div>
        </div>
      )}
    </section>
  );
}

/** Renders one generated view (Generative UI spec) with deterministic
 *  components from the catalog. The spec contains data only — never HTML. */
export function ViewRenderer({ spec }: { spec: ViewSpec }) {
  return (
    <div className="view">
      <header className="view-head">
        <span className="qid">{spec.questionId.toUpperCase()}</span>
        <span className="badge">{spec.origin === "cron" ? "自動生成" : "チャット生成"}</span>
        <time>{new Date(spec.generatedAt).toLocaleString("ja-JP")}</time>
      </header>
      <h4 className="view-title">{spec.title}</h4>
      {spec.sections.map((s, i) => (
        <div key={s.type} className="rise" style={{ "--i": i } as React.CSSProperties}>
          <Section section={s} />
        </div>
      ))}
    </div>
  );
}
