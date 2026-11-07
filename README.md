# radar-explorer — 一次情報レーダー「探検UI」

GDELT 収集プール（問い q1〜q6）に溜まった一次情報を、チャットで探索し、
出来事が起きたらその出来事専用の「画面」まで自動で組み立てる Generative UI
アプリケーション。単一の Cloudflare Worker で動く。

- 本番: https://radar-explorer.tanoshimi494.workers.dev
- **公開（public）で運用し、Cloudflare Access は付けない方針**（ユーザー決定
  2026-11-07）。URL を知れば誰でも開ける。機微なデータは扱っていない
  （収集プールは公開ニュースのメタデータのみ、書き込み系の機能はない）。

## 何ができるか

UI は「よくある AI チャット」の形（ユーザー決定 2026-11-07）。初期画面に
あるのはチャット入力欄とスレッド一覧だけで、質問するまでは何の
コンテンツも表示しない。画面（部品）はすべて、質問への回答として
会話の中にだけ生成される。

- 会話はスレッド（セッション）ごとに分かれる。新規作成・一覧・切り替え・
  過去スレッドの再開ができ、履歴はスレッドごとに保持される
- チャットで問いについて質問すると、ツール（プールの鮮度・記事検索・
  トーン推移・見立て・記録スレッド）が実行され、結果がカードやチャートの
  部品として回答の中に描画される。ツール実行のステップ詳細・生エラー・
  neurons メーター等の内部表示は画面に出さない（裏側の集計とガードは維持）
- 「いま何が注目されている？」と聞くと、世界のメディアで大きく扱われて
  いる出来事を注目度順に提示する。順位はコードが決定的に付ける
  （報道量＝同じ出来事の記事件数 → 媒体数 → 新しさ。LLM は順位を
  動かさない）。出来事を選ぶと、その出来事の画面（記事カード・時系列・
  出典・見立てパネル）がそのスレッド内に生成される。プールは
  バックフィル中のため、回答には対象期間（プールの最新日付）を明示する
- 「画面を作って」と頼んでも、その場でダッシュボード画面を生成できる
- 1 時間に 1 回の自動チェックで新着イベントを検知すると、出来事ごとの
  画面を自動生成して D1 に保存する。これは内部動作として残し、トップ画面
  には常設表示しない（サイドバーの折りたたみから開いたときだけ見える）
- 同じ読み取り専用ツールを MCP（`/mcp`）からも提供する

生成物は「下書きテキスト」ではなく画面そのもの。LLM は部品カタログから
レイアウトと文章だけを選び、データはすべてコードが実データで埋める。
LLM が HTML を書くことはない。画面に載る出典 URL と数値は、検証ゲートで
「入力集合に実在すること」を確認し、外れたものは警告フラグ付きで保存する。

## 構成

| 要素                                             | 役割                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker（`src/index.ts`）                         | ルーティング。`/mcp`、`/agents/*`、`/api/*`、静的アセット配信、Cron（`0 * * * *`）                                                      |
| Durable Object `ExplorerAgent`（`src/agent.ts`） | チャットの Agent。**スレッド＝DO インスタンス**（DO 名がスレッド ID）、履歴は DO の SQLite に保存。ツール実行と、自動生成イベントの broadcast（`radar-views`）も DO 経由 |
| MCP ハンドラ（`src/mcp.ts`）                     | `createMcpHandler` + `@modelcontextprotocol/server`。ステートレス・読み取り専用                                                            |
| D1 `radar-explorer`                              | `generated_views`（生成済み画面）、`threads`（スレッド一覧の索引: ID・タイトル・更新日時）、`state`（問い別の差分検知カーソル）、`neurons`（日次カウンタ） |
| Turso `radar-gdelt-q1`〜`q6`                     | 収集プール。**読み取り専用**（このアプリから書き込むことは一切ない）                                                                       |
| Workers AI                                       | モデル実行。API キー不要（`createAI({ binding: env.AI })`）                                                                                |
| Workers Assets                                   | React SPA の静的配信（SPA フォールバック）                                                                                                 |

設計判断の詳細は `docs/` に記録している:

- [docs/architecture.md](docs/architecture.md) — 確定スタックとその根拠、DO の役割分担
- [docs/generative-ui.md](docs/generative-ui.md) — 画面生成の方式、部品カタログ、検証ゲート仕様
- [docs/auto-generation.md](docs/auto-generation.md) — 差分検知→クラスタリング→画面生成のパイプライン、モデル方針と neurons 試算
- [docs/quality.md](docs/quality.md) — 品質ゲートとテスト・変異テストの結果、Context7 調査メモ、デザイン適用記録
- [docs/dependencies.md](docs/dependencies.md) — 依存関係の鮮度監査（2026-11-07）

## モデルと無料枠ガード

- 画面の自動生成（`env.AI.run` の直接実行）:
  `@cf/meta/llama-4-scout-17b-16e-instruct`（バランス型。ユーザー決定
  2026-11-07。70B は使わない）
- チャット（対話・ツール選択、`createAI` 経由）:
  `@cf/mistralai/mistral-small-3.1-24b-instruct`。Scout は createAI
  （agents SDK の gateway プロバイダ）経由だと空の応答を返すことを実測で
  確認したため、許可されていた代替候補の Mistral に分担させた
- 補助（neurons ガード発動時のフォールバック）:
  `@cf/meta/llama-3.1-8b-instruct-fp8-fast`
- neurons 日次ガード（Workers AI 無料枠 10,000 neurons/日）:
  D1 の `neurons` テーブルで当日消費を数え、6,000 でメイン→補助モデルに
  落とし、8,000 で自動生成を止める。試算と実績は
  [docs/auto-generation.md](docs/auto-generation.md) に記録。

## セットアップ / デプロイ

前提: Node と pnpm。Cloudflare の操作は `cf` CLI（devDependency）を使う。

```sh
pnpm install
pnpm dev          # ローカル開発（vite + @cloudflare/vite-plugin）
pnpm test         # Vitest（中核ロジックのブラックボックステスト）
pnpm typecheck    # tsrs --noEmit --checkerAssignment go
pnpm lint         # oxlint
```

デプロイ（secret はファイル経由でのみ渡す。値はリポジトリに入れない）:

```sh
# secret: TURSO_DATABASES_JSON（{"q1".."q6": {"url","authToken"}} の JSON 文字列）
./node_modules/.bin/cf deploy --secrets-file <secrets.json へのパス>
```

D1 マイグレーション:

```sh
./node_modules/.bin/cf d1 migrations apply <D1 の UUID>
```

環境変数・secret は名前のみ記載する: `TURSO_DATABASES_JSON`（secret、
上記）。それ以外は `cloudflare.config.ts` のバインディング（`AI` / `DB` /
`EXPLORER_AGENT` / `ASSETS`）で完結する。

## リポジトリ運用

muse-repo-template から作成。main への直接 push は禁止（ブランチ + PR +
ci-lint 緑でマージ）、コミットは署名付き、Lefthook + Betterleaks で
コミット/プッシュ前にシークレット検査が走る。バージョンの正は Nix
Flakes（`flake.nix` / `flake.lock`）。
