# イベント自動生成のパイプライン

`src/generate.ts`。Cron は `0 * * * *`（1 時間に 1 回、アカウントの Cron
総数は collector と合わせて 2 本 / 上限 5 本）。手動発火は
`POST /api/check-now` と Agent の `runRadarCheck()` から同じ関数を呼ぶ。

## 手順

1. **差分検知**: D1 の `state` に問い別の `last_check_at`（前回チェック時刻）と
   `last_frontier`（前回の最大 seendate）を保持。各 Turso プールから
   `fetched_at > last_check_at` の記事を取得する（初回は直近 24 時間分）
2. **発火判定**（`shouldTrigger`）: 新着が 1 件以上あり、かつ
   （新着 10 件以上 or frontier が前進した）場合だけ生成に進む
3. **決定的クラスタリング**（`clusterArticles`）: タイトルを正規化し、
   主要トークンの重なり（小さい方の集合に対する一致率 0.6 以上）で同一の
   出来事を畳む。LLM は使わない。1 回のチェックで問いあたり最大 3 画面まで
4. **画面スペック生成**: クラスタごとに LLM が部品カタログからレイアウトと
   文章を選ぶ（JSON Schema 付きの構造化出力）。壊れたら決定的フォールバック
5. **実体化と検証ゲート**: コードが実データを埋め（`materializeViewSpec`）、
   検証ゲート（docs/generative-ui.md）を通す
6. **保存と配信**: D1 の `generated_views` に保存（origin = `cron`）。
   Agent の broadcast で接続中クライアントに通知する

## モデル方針（2026-11-07 ユーザー決定の最終形 + 実測による分担）

- 自動生成（`env.AI.run` 直接）: `@cf/meta/llama-4-scout-17b-16e-instruct`
- チャット（`createAI` 経由）: `@cf/mistralai/mistral-small-3.1-24b-instruct`
- 補助: `@cf/meta/llama-3.1-8b-instruct-fp8-fast`（ガード発動時のみ）
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast` は使わない（当初案から
  ユーザー指示で引き下げ。「バランス型に」という修正指示で Scout に確定）

選定の経緯: 70B は過剰という指摘 → 8B 一本化は行き過ぎという修正 →
17B MoE の Scout が中間どころとして確定。その後の実測で、Scout は
`env.AI.run`（JSON Schema 付き構造化出力）では正常に画面スペックを生成する
（検証ゲート通過の画面を確認）が、`createAI`（agents SDK の gateway
プロバイダ）経由のチャットでは **空の応答**（テキストもツール呼び出しも無い
ステップ）を返すことが判明した。許可されていた代替候補どおり、チャットは
Mistral Small 3.1 に分担させ、実測でツール呼び出し+日本語応答の往復を確認した。
生成=Scout の実測コストは 3 件で 232 neurons（約 77 neurons/件）。

## neurons 試算

単価（neurons / 100 万トークン、公式の単価 $ と 1 neuron = $0.000011 で換算、
2026-11-07 にモデルページで確認）:

| モデル                         | input  | output  |
| ------------------------------ | ------ | ------- |
| Llama 4 Scout 17B（メイン）    | 24,545 | 77,273  |
| Llama 3.1 8B fp8-fast（補助）  | 4,119  | 34,868  |
| （参考）Llama 3.3 70B fp8-fast | 26,668 | 204,805 |

画面 1 件の生成は入力 ~1,500 / 出力 ~400 トークン程度:

- Scout: 試算 約 68 neurons/件 / **実測 約 77 neurons/件**（2026-11-07、
  手動発火で 3 件生成し D1 カウンタの増分 232 neurons から算出）
- （旧 70B 実測: 12 件で約 1,499 neurons = 約 125 neurons/件。2026-11-07 の
  手動発火時の D1 カウンタ実績）

ガード閾値は当面 6,000 / 8,000 のまま（ユーザー指示）。Scout 前提では
6,000 neurons は画面生成 約 88 件分に相当し、1 時間に 1 回×最大 18 件/回という
理論上限に日常的に達することはない。チャット対話も同じカウンタで数える。
実績値は docs/quality.md と PR の報告に都度追記する。
