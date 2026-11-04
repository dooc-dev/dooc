---
title: "書き出し"
lang: "jpn"
---

リポジトリのルートで、用途に合うコマンドを実行します。

| 用途 | コマンド | 出力先（sample-content/ 内） |
| --- | --- | --- |
| 閲覧用に共有 | `mise run export html` | `dist/index.html` |
| 他のアプリで利用 | `mise run export json` | `dist/artifact/` |
| 編集用の元資料を共有 | `mise run export zip` | `dist/sample-content.zip` |

HTMLは1ファイルで開けます。JSONとHTMLは、文書の検証エラーを解消してから書き出します。

## 共有前の確認

- [ ] 文書と図が表示される。
- [ ] ページ間のリンクが開く。
- [ ] 共有するファイルに不要な情報が含まれていない。

別の資料を書き出す場合は、`mise run export html ../my-docs` のようにルートフォルダーを指定します。
