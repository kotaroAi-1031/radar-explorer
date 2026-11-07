# radar-explorer — 一次情報レーダー「探検UI」

GDELT 収集プールに溜まった一次情報をチャットで探索する Generative UI アプリ。
6つの「監視する問い」（中東／米国の対中南米・対麻薬政策／日本の経由地化／テックのパワー構造／AI一次情報／セキュリティ実務）について質問すると、出典つきの部品（記事カード・時系列・グラフなど）で答え、出来事ごとの画面も生成する。単一の Cloudflare Worker で動き、アクセスは Cloudflare Access で所有者本人のみに制限している（メールアドレス宛ワンタイムコードでログイン）。

## リンク集

- 本番アプリ: https://radar-explorer.tanoshimi494.workers.dev/
- 発表スライド: https://kotaroai-1031.github.io/radar-explorer/slides/ （[印刷版](https://kotaroai-1031.github.io/radar-explorer/slides/print.html)）
- GitHub: [リポジトリ](https://github.com/kotaroAi-1031/radar-explorer) ／ [Issues](https://github.com/kotaroAi-1031/radar-explorer/issues) ／ [Pull Requests](https://github.com/kotaroAi-1031/radar-explorer/pulls)
- ドキュメント: [アーキテクチャ](docs/architecture.md) ／ [Generative UI の方式](docs/generative-ui.md) ／ [自動生成](docs/auto-generation.md) ／ [依存関係](docs/dependencies.md) ／ [品質](docs/quality.md)

## 開発

```sh
pnpm install
pnpm dev          # ローカル開発
pnpm test         # Vitest
pnpm typecheck    # tsrs
pnpm lint         # oxlint
./node_modules/.bin/cf deploy --secrets-file <secrets.json へのパス>
```

secret は `TURSO_DATABASES_JSON` のみ（値はリポジトリに入れない）。main への直接 push は禁止で、変更はブランチ + PR + CI 緑でマージする。
