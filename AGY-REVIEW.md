# agy レビュー依頼（radar-explorer）

対象リポジトリ：kotaroAi-1031/radar-explorer（main の最新状態）

## レビューの目的
一次情報レーダー「探検UI」（Cloudflare Workers の単一 Worker + Durable Objects の Agent + MCP + D1、Generative UI）のコードレビュー。UI 部分とロジック部分の両方。

## 進め方（必須）
- まずこのファイルと同じ内容で、レビュー結果ファイル `AGY-REVIEW-RESULT.md` をリポジトリ直下に作成し、見出しと要約欄（P0〜P3 の件数は TBD）だけ先に書く
- 指摘が1件固まるたびに、その場で結果ファイルへ追記する（最後にまとめて書かない）
- コードは変更しない（レビューのみ）

## 観点
- ロジック：MCP ツール（pool_status / search_articles / tone_trend）の正確性、イベント自動生成（差分検知→決定的クラスタリング→画面の UI スペック生成→検証ゲート→ D1 保存→ broadcast）、検証ゲート（出典 URL・数値がツール結果に実在すること）、neurons ガード（上限管理）、空状態の扱い（空プールで生エラーを出さないか）、Durable Object の状態管理と再開可能性
- UI：Generative UI の部品描画（tool parts → React コンポーネント）、モデル出力の安全な描画（innerHTML を使っていないか）、アクセシビリティ、モバイル（iPhone / Safari）での表示、ローディングとエラー表示
- その他：秘密情報の混入、未使用コード、ドキュメントとの不整合

## 出力形式
指摘ごとに：深刻度（P0〜P3）、ファイルパスと行、具体的な根拠、修正案。根拠のない推測の指摘は書かない。最後に要約欄の件数を実数に更新する。
