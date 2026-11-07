# アーキテクチャと確定スタックの根拠

設計書の正は `~/workspace/radar/explorer/DESIGN.md`（v2）。ここには実装時に
確定した判断と、その根拠だけを残す。

## 確定スタック

- 単一 Cloudflare Worker（Workers Assets の SPA 配信 + Durable Objects 同居）
- フロント: React 19 + `useAgentChat`（`@cloudflare/ai-chat/react`）+
  `useAgentToolEvents`（`agents/react`）
- Agent: `AIChatAgent`（`@cloudflare/ai-chat`）
- モデル接続: `createAI({ binding: env.AI })`（`agents/models/ai-sdk`）。
  Workers AI バインディング直結で API キー不要
- MCP: `createMcpHandler` + `@modelcontextprotocol/server` を同一 Worker の
  `/mcp` に配置（ステートレス、読み取り専用）
- データ: Turso `radar-gdelt-q1`〜`q6` は読み取り専用。新規 D1 を 1 つ
  （`generated_views` / `state` / `neurons`）
- 運用: デプロイとリソース操作は `cf` CLI（npm パッケージ `cf`）
- 認証: **付けない（public 運用）**。当初は Cloudflare Access を予定したが、
  アカウント側で Access が未有効化（API が `access.api.error.not_enabled`）
  だったことと、扱うデータが公開ニュースのメタデータのみであることから、
  ユーザーが 2026-11-07 に「最初はアクセスなし」「public で」と決定した

## Durable Object の役割分担

- チャットの Agent は Durable Object。会話 1 つ = DO インスタンス 1 つで、
  会話履歴は DO の SQLite に永続化される（再接続しても続きから話せる）
- 自動生成イベントの通知も DO 経由: Cron 側のチェックが新しい画面を保存したら、
  チェック用スタブ（`stub.runRadarCheck()`）が生成と保存を行い、接続中の
  クライアントへは Agent の broadcast（メッセージ種別 `radar-views`）で
  「新しい画面ができました」を配信する。クライアントは受信すると画面一覧を
  再取得する
- ルーティングの注意: `routeAgentRequest` は URL セグメントを **env の
  バインディング名**（kebab-case 化）から解決する。バインディング名を
  `EXPLORER_AGENT` にしたため、パスは `/agents/explorer-agent/<room>` に
  なり、クライアントは `useAgent({ agent: "explorer-agent" })` で接続する

## ライブラリ選定の追加判断

- チャート: TanStack Charts（`@tanstack/charts`）。Recharts は使わない
  （ユーザーの既決ルール）。grammar-of-graphics 型の `defineChart` に
  barY（件数）/ lineY（平均トーン）の marks を渡す
- UI 部品: Base UI（`@base-ui/react`）を直接使う（shadcn/ui は使わない）。
  サイドバーのタブに使用
- 描画: Tailwind は使わず、最新の CSS 機能（カスタムプロパティ、color-mix、
  コンテナ的なレイアウト、View Transitions 前提の素直な遷移）で書く
- Markdown: 助手のテキストは Streamdown で描画する（Agents 公式例の作法。
  テキストは React の text として描画され、`innerHTML` にモデル出力を
  流す経路は存在しない）
- アニメーション: Emil Kowalski 流（割り込める、出入りの非対称、
  `prefers-reduced-motion` 尊重）。部品がストリーミングで順に現れる体験は
  Vercel AI SDK の Generative UI の「型」を参照した（SDK 自体は導入しない）。
  抑制的な余白とタイポグラフィは catnose 氏の作法を参照

## データの境界

- 収集プール（Turso）へは SELECT のみ。書き込みはコード上に存在しない
- baselines / threads はビルド時に `scripts/sync-content.mjs` で
  `src/content.generated.ts` へ同梱する読み取り専用コピー。本体ファイルは
  書き換えない
- secret は `TURSO_DATABASES_JSON` の 1 つだけ。デプロイ時に
  `--secrets-file` で渡し、リポジトリにもログにも値を出さない
