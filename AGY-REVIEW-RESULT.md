# radar-explorer コードレビュー結果

## 要約

| 深刻度 | 件数 | 説明 |
| --- | --- | --- |
| P0 | 0 | 本番障害・データ破損・セキュリティ脆弱性・機能不全に直結する重大な問題 |
| P1 | 6 | 仕様違反・不正確なロジック・検証ゲートの抜け・重要なエッジケース未処理 |
| P2 | 3 | 堅牢性・UI/UX・アクセシビリティ・保守性の改善項目 |
| P3 | 1 | 軽微な整理・未使用コード・ドキュメント整合性など |

---

## 指摘一覧

### 1. [P1] マルチスレッド化に伴い、Cron / 手動チェックの `radar-views` ブロードキャストが `"main"` 以外のスレッド接続クライアントに届かない

- **ファイルパスと行**:
  - `src/index.ts:101-105`, `src/index.ts:110-126`
  - `src/agent.ts:462-476`
  - `src/client/App.tsx:361-374`
- **具体的な根拠**:
  - `ChatPanel` は現在選択中のスレッド ID を DO 名として `useAgent({ agent: "explorer-agent", name: threadId })` に接続し、その WebSocket 上で `type: "radar-views"` メッセージを待ち受けている（`src/client/App.tsx:361-374`）。
  - 一方、`scheduled` ハンドラ（`src/index.ts:115`）および `POST /api/check-now`（`src/index.ts:102`）は常に固定の `"main"` インスタンス（`getAgentByName(env.EXPLORER_AGENT, "main")`）に対してのみ `runRadarCheck()` を呼び出している。
  - Durable Object の `this.broadcast()`（`src/agent.ts:465`）はその DO インスタンス（`"main"`）に接続している WebSocket にしか配信されないため、利用者が新規作成したスレッド（UUID 名の DO インスタンス）を開いている場合、新着画面が自動生成されても通知が届かず画面一覧が自動更新されない。
- **修正案**:
  - `ExplorerAgent` にブロードキャスト配信用の RPC メソッド（例: `notifyRadarViews`）を用意し、`runRadarCheck()` で新着画面が生成された際に自身の `this.broadcast()` に加えて D1 の `threads` テーブルにあるスレッド（`"main"` 以外）の DO スタブへも通知を配信するようにする。
- **対応**: 修正済み。実コードで配信経路を確認し、`ExplorerAgent.notifyRadarViews`（RPC）を追加して、`runRadarCheck()` が自身の broadcast に加え、D1 `threads` の全スレッド（自分以外）のスタブへ同じペイロードを中継するよう変更した。中継の失敗はスレッドごとにログに留め、チェック自体は失敗させない。

### 2. [P1] `poolStatus` / `toneTrend` / `newArticlesSince` の SQL クエリに `question_id = ?` 条件が欠落している

- **ファイルパスと行**:
  - `src/radar.ts:55-68`（`poolStatus`）
  - `src/radar.ts:215-220`（`toneTrend`）
  - `src/radar.ts:238-243`（`newArticlesSince`）
- **具体的な根拠**:
  - 同じ `src/radar.ts` 内の `searchArticles`（`src/radar.ts:95`）、`recentArticles`（`src/radar.ts:139`）、`mediaBreakdown`（`src/radar.ts:183, 188`）はすべて `WHERE question_id = ?` で対象の問いの記事に絞り込んでいる。
  - しかし `poolStatus`（累計・frontier・直近24h件数）、`toneTrend`（日別件数と平均トーン）、`newArticlesSince`（差分検知の新着記事取得）の3関数だけ `WHERE question_id = ?` が抜けておりテーブル全件を対象にしている。そのため、同一 DB の共有構成や誤混入行がある場合に `searchArticles` / `mediaBreakdown` の件数と `poolStatus` / `toneTrend` / `newArticlesSince` の件数が食い違う。
- **修正案**:
  - `poolStatus`（累計・frontier 取得および `seendate >= ?` の直近24h集計）、`toneTrend`、`newArticlesSince` のすべての SQL に `question_id = ?` 条件とバインド引数を追加し、`searchArticles` 等と一貫させる。
- **対応**: 修正済み。実コードで再現を確認し、`poolStatus` の2クエリ・`toneTrend`・`newArticlesSince` の全 SQL に `question_id = ?` とバインド引数を追加した。

### 3. [P1] `build_view` ツールで検証ゲート（`verifyViewSpec`）に渡す記事集合とタイトル上書きが不整合で、正常な画面が `verified = 0`（警告付き）になる

- **ファイルパスと行**:
  - `src/agent.ts:238-281`
  - `src/views.ts:285-310`
- **具体的な根拠**:
  1. `build_view` は `searchArticles` で取得した `withFetched`（最大30件）をクラスタリングし、先頭クラスタ `cluster = clusters[0]` から `ruleBasedChoice` と `materializeViewSpec` で画面を生成している（`src/agent.ts:238-261`）。このとき `factualProse` が要約文に `記事 ${cluster.articles.length} 件` を埋め込む（`src/views.ts:303-304`）。
  2. ところが直後の `verifyViewSpec`（`src/agent.ts:265-270`）および `saveView`（`src/agent.ts:271-280`）には `cluster.articles` ではなく検索結果全体の `withFetched` を渡している。そのため `allowedNumbersFor(ctx.articles)` には `withFetched.length` しか入らず、要約文の `cluster.articles.length` が「入力に現れない数値」として誤検出され、`saveView` の `article_count` も `stat_row.clusterSize` と食い違う。
  3. さらに `args.keyword` 指定時（`src/agent.ts:262-264`）およびクラスタが空のときの `factualProse`（`src/views.ts:306`）で `QUESTION_LABELS[qid]`（例: `"問い5：..."`）が `spec.title` に入るため、ラベル内の数字（`1`〜`6`）やキーワード内の数字が `verifyViewSpec` で「入力に現れない数値」として警告される。
- **修正案**:
  - `build_view` の `verifyViewSpec` と `saveView` には `cluster.articles`（およびその URL 集合・件数）を渡すように統一する。
  - `args.keyword` 指定時のタイトルに問い番号を含めず（画面ヘッダに `questionId` バッジが既に表示されるため `「${args.keyword}」に関する記事（${ top?.title ?? ... }）` 等にするか、キーワード文字列中の数値を許容集合に含める）、空クラスタ時のフォールバックタイトルも数値を含まない見出しにする。
- **対応**: 修正済み。実コードで不整合を確認し、`build_view` の `verifyViewSpec`（記事集合・URL 集合・trend）と `saveView`（件数）を `cluster.articles` に統一した（cron 生成・出来事画面の経路と同契約）。キーワード時のタイトルは問いラベルを使わず「『キーワード』記事：先頭見出し」形式に変更し、`factualProse` の空クラスタ時フォールバックタイトルも数値を含まない見出しにした。

### 4. [P1] 検証ゲートの `allowedNumbersFor` が `seendate` の年月日やカンマ有無・トレンド数値を許容せず、正当な日付表現やドキュメント仕様（`docs/generative-ui.md`）と乖離している

- **ファイルパスと行**:
  - `src/logic.ts:285-305`
  - `src/views.ts:373-402`, `src/views.ts:428-433`
  - `docs/generative-ui.md:65-67`
- **具体的な根拠**:
  1. `allowedNumbersFor`（`src/logic.ts:295-305`）は `seendate`（例: `"20260815T120000Z"`）に対して単純に `extractNumbers` を呼ぶため、許容集合には連結された `"20260815"` と `"120000"` しか入らない。モデルが記事の `seendate` に基づいて `"2026年8月15日"` や `"8月15日"` と要約・見出しに書いた場合、`"2026"`, `"8"`, `"15"` がすべて「入力に現れない数値」と判定され、`verified = 0` の誤警告になる。
  2. 記事タイトル中のカンマ区切り数値（例: `"1,250"`）と本文中のカンマなし表記（`"1250"`）が別文字列として扱われ、不一致になる。
  3. `docs/generative-ui.md:65-67` には「数値の許容集合は `allowedNumbersFor` が作る: 記事タイトルと seendate から抽出した数値、記事件数、トレンドの日別件数・トーン（丸め違いを吸収するため整数化した値も含む）」と明記されているが、実装の `allowedNumbersFor` はトレンドの日別件数・トーンを受け取っていない。
- **修正案**:
  - `allowedNumbersFor` で `seendate` から年・月・日（先頭ゼロ有無の両方）を展開して許容集合に追加し、カンマ区切り数値の正規化（カンマ除去形）も登録する。
  - `allowedNumbersFor`（および `ViewGateContext`）が任意の `trend`（`ToneTrendPoint[]`）を受け取れるようにし、日別 `count` と `avgTone`（小数第1位・四捨五入整数など）も許容集合に含める。
- **対応**: 修正済み。実コードと `docs/generative-ui.md:65-67` の記述を確認し、`allowedNumbersFor` に seendate の年月日展開（先頭ゼロ有無の両方）、カンマ除去形の併記、任意引数 `trend`（日別 count と avgTone の小数第1位・整数化した絶対値）を実装。`ViewGateContext.trend` を追加し、呼び出し側3箇所（cron 生成・出来事画面・`build_view`）すべてで trend を渡すよう統一した。テスト5件を追加（logic 3件・views 2件）。

### 5. [P1] neurons ガード発動時（上限到達時）にも D1 `state` の `last_check_at` / `frontier` を進めてしまい、未生成の差分が永久にスキップされる（＋クラスタ単位の再判定・自動タイトル生成のガード未適用）

- **ファイルパスと行**:
  - `src/generate.ts:510-553`
  - `src/agent.ts:350-379`
- **具体的な根拠**:
  1. `runRadarCheck`（`src/generate.ts:510-553`）において、`pickModel(env)` が `null`（本日の累計が 8,000 neurons 以上で自動生成停止）を返した場合、`entry.skipped = "neurons guard: daily budget exhausted"` と記録して画面生成をスキップするにもかかわらず、直後の `src/generate.ts:547-552` で無条件に `state` テーブルの `last_check_at` と `frontier` を更新している。結果として、上限到達中に到着した記事群は翌日（UTC 日付変更後）のチェックでも「処理済み」扱いとなり、画面が二度と生成されない。
  2. `pickModel(env)` が問いループの先頭（`src/generate.ts:511`）で1回しか呼ばれないため、同一の問いで最大3クラスタ（再試行込みで最大6回の LLM 呼び出し）を処理する途中で 6,000 / 8,000 閾値を跨いでもモデル切り替え・停止が反映されない。
  3. スレッドの自動タイトル生成 `maybeGenerateTitle`（`src/agent.ts:351-377`）は `neurons` の消費を記録しているものの、呼び出し前に `pickModelForUsage(await neuronsUsedToday(this.env))` を確認していないため、8,000 neurons 到達後も LLM 呼び出しが走る（フォールバック `fallbackTitle(userText)` がすぐ下に実装されているにもかかわらず活用されていない）。
- **修正案**:
  - `runRadarCheck` ではクラスタごとのループ内で `pickModel(env)` を確認し、neurons ガードにより生成がスキップされた場合は当該問いの `state`（`last_check_at` / `frontier`）を更新せず次回チェックへ持ち越す。
  - `maybeGenerateTitle` でも `pickModelForUsage(await neuronsUsedToday(this.env)) === null` の場合は LLM 呼び出しを行わず決定的な `fallbackTitle(userText)` を使用する。
- **対応**: 修正済み。実コードで3点とも再現を確認し、(1) ガード停止時は問いの `state` を更新せず差分を持ち越す、(2) クラスタごとの反復で `pickModel(env)` を再確認してモデル切替・停止を即時反映する、(3) `maybeGenerateTitle` はガード到達時にモデル呼び出しをせず `fallbackTitle` を使う、よう変更した。なお (1) のトレードオフとして、ループ途中でガードが発動した場合に同回で生成済みのクラスタは翌日再生成され重複画面が残りうるが、差分が静かに失われる元の不具合より可視で無害な側を取った。あわせて指摘8の `runRadarCheck` 内 `newArticlesSince` の例外捕捉もこの変更に含めた（問い単位で記録して継続し、その問いの `state` は進めない）。自動生成の再開に関わる設定変更はしていない（消費抑制と持ち越しのみ）。

### 6. [P1] Generative UI の `ToolOutput` に `media_breakdown` の描画分岐が無く、媒体内訳ツールの結果が画面に表示されない（＋一部部品の空状態欠落）

- **ファイルパスと行**:
  - `src/agent.ts:111-128`
  - `src/client/App.tsx:153-162`, `src/client/App.tsx:220-252`
  - `src/client/ViewRenderer.tsx:72-83`
- **具体的な根拠**:
  1. `ExplorerAgent` は媒体別の記事件数・シェアを集計する `media_breakdown` ツールを提供しており、システムプロンプトでも「媒体（メディア）の内訳を聞かれたら `media_breakdown` を呼ぶ」と指示している（`src/agent.ts:43, 111-128`）。
  2. しかしクライアント側の `ToolOutput`（`src/client/App.tsx:220-252`）の `switch (name)` に `case "media_breakdown":` が存在せず `default: return null` に落ちるため、ツールが正常に出力を返しても空の `<div className="toolpart">` だけが描画され、Generative UI 部品が表示されない。
  3. また、`ListViewsOutput`（`src/client/App.tsx:153-162`）で `views` が 0 件の場合や、`ViewRenderer` の `source_list`（`src/client/ViewRenderer.tsx:72-83`）で `sources` が 0 件の場合に、他の部品（`ArticleCards`, `Timeline`, `ToneChart`, `HotEventsOutput`）にある空状態メッセージ（`<p className="empty">...</p>`）が無く、空の `<ul>` 要素が出力される。
- **修正案**:
  - `src/client/App.tsx` に `MediaBreakdownOutput` コンポーネント（累計記事数・媒体種類数・上位ドメインの件数と割合リスト、および 0 件時の空状態文言）を追加し、`ToolOutput` の `case "media_breakdown":` で描画する。
  - `ListViewsOutput` および `ViewRenderer` の `source_list` でも 0 件時に穏当な空状態メッセージを表示する。

### 7. [P2] チャット応答・出来事画面生成・初期データ取得におけるローディング表示とエラー表示の不足

- **ファイルパスと行**:
  - `src/client/App.tsx:169-218`
  - `src/client/App.tsx:376-430`
  - `src/client/App.tsx:504-520`
- **具体的な根拠**:
  1. `ChatPanel` の `useAgentChat`（`src/client/App.tsx:376-382`）で `status === "error"`（または `error`）を扱っておらず、ストリーム通信やモデル呼び出しが失敗した際にメッセージ欄へエラー通知が表示されない。また `status === "submitted"` の待機中も送信ボタンの文字が変わるだけで、メッセージ領域にローディング状態（`role="status"`）が表示されない。
  2. `openEvent`（`src/client/App.tsx:405-417`）は `POST /api/threads/:id/event-view` のレスポンスステータスや `{ error }` ペイロードを確認しておらず、404（プール更新でクラスタが消滅した場合など）や通信失敗時に無反応で終わる。また成功時にも `onViewsChanged()` / `onThreadsChanged()` を呼んでいないため、サイドバーの生成済み画面一覧やスレッド更新時刻が反映されない。さらに `pendingKey` が `clusterKey` のみで管理されており、リクエスト中に別の出来事の「画面を見る」ボタンを重複押下できてしまう。
  3. `loadThreads` / `loadViews`（`src/client/App.tsx:504-520`）の `fetch` に `try/catch` が無く、ネットワーク切断時に未処理の Promise rejection が発生する。
- **修正案**:
  - `ChatPanel` で `status === "submitted"` 時のローディング表示と、`status === "error"` 時および `openEvent` 失敗時の穏当なエラーメッセージをメッセージ欄に表示する。
  - `openEvent` ではリクエスト中の重複押下を抑止し、成功時に `onViewsChanged()` / `onThreadsChanged()` を呼び、失敗時はサーバーが返した穏当なエラー文言（またはフォールバック文言）を表示する。
  - `loadThreads` / `loadViews` を `try/catch` で保護する。

### 8. [P2] MCP サーバー・HTTP API・Cron チェックにおける例外未捕捉と `searchArticles` の `LIKE` ワイルドカード未エスケープ

- **ファイルパスと行**:
  - `src/mcp.ts:22-140`
  - `src/index.ts:78-105`
  - `src/generate.ts:474-505`
  - `src/radar.ts:97-100`
- **具体的な根拠**:
  1. `src/agent.ts` の各ツールは `try/catch` で保護され生エラーを出さない設計になっている一方、`src/mcp.ts` の全ツール（`pool_status`, `search_articles`, `tone_trend`, `list_views`, `get_view`）および `src/index.ts` の `/api/status`・`/api/views` には `try/catch` が無く、Turso / D1 の一時障害や不正 JSON がある場合に未処理例外（500 エラー）になる。
  2. `runRadarCheck`（`src/generate.ts:501`）で `newArticlesSince(env, qid, since)` が `try/catch` されておらず、6つの問いのうち1つの Turso プールで通信エラーが起きると後続の問いのチェック全体が中断する。
  3. `searchArticles`（`src/radar.ts:97-100`）の `title LIKE ?` でキーワード内の `%` や `_` をエスケープしていないため、`"100%"` や `"open_source"` などの検索で SQLite のワイルドカードとして解釈され、意図しない記事がヒットする。
- **修正案**:
  - `src/mcp.ts` の各ツールハンドラおよび `src/index.ts` の API ルートを `try/catch` で保護し、穏当なエラー応答を返すようにする。
  - `runRadarCheck` の `newArticlesSince` 呼び出しも問い単位で `try/catch` し、失敗した問いは `entry.skipped` に記録して他の問いの処理を継続する。
  - `searchArticles` で `%`, `_`, `\` をエスケープし `title LIKE ? ESCAPE '\\'` を使用する。
- **対応**: 修正済み。実コードで未捕捉を確認し、`src/mcp.ts` の全ツール（7件）を `try/catch` で保護してチャット側ツールと同じ穏当なエラー文言を返すよう統一、`src/index.ts` の `/api/status`・`/api/views` にも `try/catch`（500＋穏当な文言）を追加した。`newArticlesSince` の問い単位の捕捉は指摘5の変更に含めて実施（失敗した問いは `skipped` に記録し、その問いの `state` は進めずに継続）。`searchArticles` の LIKE エスケープは指摘2の変更に含めて実施した。

### 9. [P2] アクセシビリティ属性の不足・モバイル（iPhone / Safari）表示の崩れ・外部リンク URL スキーム検証の未実装

- **ファイルパスと行**:
  - `src/client/App.tsx:385-387`, `src/client/App.tsx:421`, `src/client/App.tsx:467-486`, `src/client/App.tsx:592-606`
  - `src/client/ViewRenderer.tsx:23`, `src/client/ViewRenderer.tsx:45`, `src/client/ViewRenderer.tsx:76`
  - `src/client/styles.css:37-41`, `src/client/styles.css:95-102`, `src/client/styles.css:133-139`, `src/client/styles.css:547-554`, `src/client/styles.css:641-686`, `src/client/styles.css:689-713`
- **具体的な根拠**:
  1. **アクセシビリティ**:
     - スレッド一覧（`src/client/App.tsx:594-605`）で選択中のスレッドボタンに `aria-current` 属性が付与されておらず、スクリーンリーダーで現在開いているスレッドを判別できない。
     - チャットのメッセージ一覧（`src/client/App.tsx:421`）に `role="log"` / `aria-live="polite"` が無い。
     - `ViewOverlay`（`src/client/App.tsx:467-486`）で閉じるボタン（`.overlay-close`）が `position: absolute; top: 10px; right: 10px`（`src/client/styles.css:704-713`）のため、`<dialog>` 内の `.view` ヘッダ右上に重なり、またダイアログ内スクロール時に画面外へ流れてしまう。
  2. **モバイル（iPhone / Safari）での表示・挙動**:
     - `chatEndRef.current?.scrollIntoView({ behavior: "smooth" })`（`src/client/App.tsx:385-387`）が初期マウント時（メッセージ0件時）にも発火し、かつ `scrollIntoView` がページ全体のウィンドウスクロールを巻き込むため、1カラム縦積みになる iPhone 表示で初回表示時にサイドバーが画面外へ飛ばされる。また `prefers-reduced-motion: reduce` 設定時も `"smooth"` が強制される。
     - `.thread-list`（`max-height: 46vh`）や `.chat .messages`（`max-height: 62vh`）が `vh` 指定のみで、モバイル縦積み時にスレッド一覧が画面の半分近くを占めてチャット欄を押し下げ、iPhone の下部セーフエリア（`env(safe-area-inset-bottom)`）も考慮されていない。
     - 小画面（`max-width: 560px`）で `.event-row`（`src/client/styles.css:641-649`）が横1行固定のため、チャットバブル内でタイトル領域が極端に狭くなり数文字ごとに折り返される。
  3. **URL スキームの安全検証**:
     - モデル出力テキスト自体は `Streamdown` と React テキストノードで描画されており `innerHTML` は使われていないが、`ViewRenderer.tsx`（`23, 45, 76` 行目）の `<a href={...}>` は URL が `http:` / `https:` スキームであるかを検証していない。
- **修正案**:
  - スレッド一覧の選択中ボタンに `aria-current="page"` を付与し、`.messages` に `role="log" aria-live="polite"` を設定する。
  - Меッセージ自動スクロールは `.messages` コンテナ自身の `scrollTop` 操作（メッセージが存在するときのみ）に変更し、ページ全体のスクロール巻き込みを防ぐ。
  - `ViewOverlay` の閉じるボタンを sticky ヘッダ配置にして本文との重なり・スクロール消失を解消する。
  - モバイル向けに `dvh`・`env(safe-area-inset-bottom)`・小画面での `.thread-list` 高さ圧縮・`.event-row` の折り返しレイアウトを追加する。
  - `ViewRenderer` で `http://` / `https://` 以外の URL をリンク化しないヘルパーを導入する。

### 10. [P3] CSS セレクタ名の不整合（`.tool-output` vs `.toolpart`）・未使用クラス・ドキュメントと実装の記述差分

- **ファイルパスと行**:
  - `src/client/styles.css:239-242`, `src/client/styles.css:334-355`, `src/client/styles.css:534-539`
  - `src/client/App.tsx:134-151`, `src/client/App.tsx:269`
  - `docs/architecture.md:9-10`, `docs/architecture.md:16-17`, `docs/architecture.md:48-49`
  - `docs/auto-generation.md:9-10`, `docs/auto-generation.md:50-54`
- **具体的な根拠**:
  1. **CSS セレクタの不整合と未使用ルール**:
     - `App.tsx:269` のツール結果ラッパーのクラス名は `.toolpart` だが、`styles.css:335, 345` では旧クラス名の `.tool-output details summary` / `.tool-output pre` のままになっている。そのため、`get_baseline` / `get_thread`（`DocOutput`、`App.tsx:146-149`）の `<summary>` に `min-height: 44px` が当たらず、`<pre>` に `white-space: pre-wrap` や `max-height: 320px` が適用されずに長文が折り返されない。
     - `styles.css:239-242`（`.badge-warn`）および `styles.css:534-539`（`.warnings`）は現在の JSX から参照されていない未使用セレクタである。
  2. **ドキュメントの不整合**:
     - `docs/architecture.md:9-10` で `useAgentToolEvents`（`agents/react`）と記載されているが、実装（`src/client/App.tsx:2`）は `useAgent` を使用している。
     - `docs/architecture.md:16-17` の D1 テーブル一覧に `threads`（`migrations/0003_threads.sql`）が含まれておらず、`48-49` 行目に現在は使われていない「サイドバーのタブに使用（`@base-ui/react`）」の記述が残っている。
     - `docs/auto-generation.md:9-10` で `state` テーブルのカラム名を `last_frontier` と記載しているが、実装（`migrations/0001_init.sql:21`、`src/generate.ts:491`）は `frontier` である。また `50-54` 行目の neurons 単価表にチャット用モデル `Mistral Small 3.1 24B`（input 31,909 / output 50,455、`src/logic.ts:49`）が載っていない。
- **修正案**:
  - `src/client/styles.css` の `.tool-output` を `.toolpart` に修正し、未使用の `.badge-warn`・`.warnings` を整理する。
  - `docs/architecture.md` と `docs/auto-generation.md` の記述を現行実装に合わせて更新する。
