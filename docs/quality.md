# 品質ゲートとテストの記録

## 品質ゲート（2026-11-07、PR マージ前の最終結果）

| ゲート                                                                              | 結果                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| React Doctor（`src/client`、全ルール）                                              | **100 / 100**（初回 69 → 指摘 7 件をすべてコード側で修正: 関数分割、`<meter>` 要素化、キー付与の適正化、ユーティリティの分離） |
| oxlint（`src`、96 ルール）                                                          | **0 warnings / 0 errors**                                                                                                      |
| oxfmt                                                                               | 全ファイル適用済み（`--check` 通過）                                                                                           |
| tsrs 型チェック（`tsrs --noEmit --checkerAssignment go`、0.20.1-ts7.1.0-beta ピン） | **0 errors**（意図的に型エラーを入れたプローブで検出できることも確認済み）                                                     |
| tsc --noEmit（補助）                                                                | 通過                                                                                                                           |
| Vitest                                                                              | **46 件全通過**（`src/logic.test.ts` / `src/views.test.ts`）                                                                   |
| 変異テスト（@mizchi/mutator、対象 logic.ts + views.ts）                             | **mutation score 82.9%**（Killed 174 / Survived 33 / NoCoverage 3）                                                            |

## テスト方針

古典派（Detroit school）のブラックボックステスト。モックで内部構造を
なぞらず、公開関数の入力→出力の対応だけを見る。対象は中核ロジック:
決定的クラスタリング、検証ゲート、UI スペック生成（materialize）、
neurons ガード（モデル選択と推定）、差分検知の発火判定、seendate 変換。

変異テストの生存者の内訳: 2 文字の英語ストップワード（"a" "of" など）の
除去変異が大半で、トークンの最小長（3 文字）規則により振る舞いが変わらない
等価変異。その他はクラスタ採点の同点処理とクラスタキー（不透明な文字列）の
細部で、いずれも外部から観測できる振る舞いの差にはならないものに絞られた。
モデル ID は文字列リテラルで直接検証し、seendate は分・秒・前後のゴミ付き
入力まで往復させるよう補強した（75.2% → 82.9%）。

## Context7 で確認したライブラリ（Kody 経由、実装前）

| ライブラリ                                                   | 確認した要点                                                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Agents（`/cloudflare/agents`）                    | 公式例のチャット描画作法: `message.parts` を配列順に 1 つの map で描く、助手テキストは Streamdown、ツールの入力・出力・エラーすべてを描く       |
| MCP TypeScript SDK（`/modelcontextprotocol/typescript-sdk`） | `createMcpHandler(factory)` + `McpServer.registerTool(name, { description, inputSchema }, handler)` の形                                        |
| TanStack Charts（`/tanstack/charts`）                        | `defineChart({ marks: [barY / lineY], scales, tooltip })`、スケールは `@tanstack/charts/scales/*`、描画は `@tanstack/charts/react` の `<Chart>` |
| Base UI（`/websites/base-ui_react`）                         | Tabs は Root / List / Tab / Panel の部品構成                                                                                                    |
| React 19（`/react/react`）                                   | 関数コンポーネント前提の現行作法                                                                                                                |

## デザイン適用記録（Impeccable の観点）

仕上げフェーズで critique / audit / polish の観点を手作業で適用した:

- critique: 画面の主役は「生成された画面」のはずが、当初は下書き前提の
  左カラム構成だった。Generative UI 訂正に合わせ、生成済み画面をチャット
  欄の流れに統合し、サイドバーは鮮度と履歴に役割を限定した
- audit（a11y）: タップターゲット 44px 以上、`<meter>` など意味のある
  要素の使用、`prefers-reduced-motion` でアニメーション無効化、
  チャートには aria-label、横スクロールなし（`overflow-x: clip`）
- polish / delight: 部品は `.rise`（12px の立ち上がり + フェード、40ms
  ずつのスタッガー）で順に組み上がる。スケルトンの shimmer、ボタンの
  `:active` スケールなど、割り込み可能で邪魔にならない動きだけに限定した
- slop 検出（`npx impeccable detect`）: ソース走査では指摘 0 件
  （正規表現レベルのルールのみという留保つき）。URL 走査はこの VM では
  Chromium の sandbox 制約で実行できなかった

## デプロイ後の実地検証（2026-11-07）

- トップ表示 200、配信バンドルに「下書き」「承認待ち」の文言が無いことを
  バイト列で確認（生成物の呼称は「生成された画面」に統一済み）
- `/api/status` が実データ（問い別 frontier・累計）を返し、`/api/views` に
  cron / chat 両 origin の画面が保存されている
- チャット 1 往復（Mistral）: pool_status のツール実行→日本語応答を確認。
  「問い1のトーン推移は？」でもエラーにならず、収集 0 件である旨の正常な
  回答になった（空プールは空状態として扱う修正を含む）
- イベント生成（Scout）: state を 24 時間巻き戻して手動発火し、q5 で
  3 件の画面が生成・保存され、うち検証ゲート通過（verified=1）を確認

## 既知のデータ事情

- 収集プールの `tone` は、現在のバックフィル範囲では全行 NULL
  （行レベルでも集計でも確認済み）。トーンチャートは件数バーが描画され、
  平均トーン線は「トーン値のある日がありません」の空状態になる。
  collector 側が tone を埋めるようになれば自動的に線も描かれる
- プールは 2026 年 8 月のバックフィルが中心で、問い q1 は収集 0 件。
  空プールはエラーではなく空状態として扱う（ツールは例外を投げない）
