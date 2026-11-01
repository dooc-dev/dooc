---
title: "書き出し"
lang: "jpn"
description: "用途に応じてJSON・HTML・ZIPを作成する。"
---

## 形式を選ぶ

:::term(artifact)
name: "artifact"
definition: "docs.json と、図ごとのJSONからなるコンパイラの出力。"
:::

| 形式 | 用途 | 出力先の既定値 |
| --- | --- | --- |
| JSON | 別のアプリケーションから利用する | `dist/artifact/` |
| HTML | 1ファイルで閲覧用に配布する | `dist/index.html` |
| ZIP | 編集可能な元資料を渡す | `dist/<root name>.zip` |

## サンプルを書き出す

リポジトリのルートで実行します。

```bash
mise run export json
mise run export html
mise run export zip
```

生成物は `sample-content/dist/` に保存されます。別の docs root を指定する場合は、形式の後にパスを渡します。

```bash
mise run export html ../my-docs
```

:::callout[配布前の確認]
- 検証エラーがあると、JSONとHTMLは書き出されません。
- 生成したHTMLを開き、本文と図の表示を確認します。HTMLの説明図は編集画面のリソース一覧から確認します。
- 元資料を渡す場合は、ZIPの内容に不要な情報がないか確認します。
:::

確認項目の一覧は[公開前チェック](doc:a)にあります。
