---
title: "はじめに"
lang: "jpn"
description: "サンプルを起動し、文書を編集して表示を確認する。"
---

## サンプルを起動する

リポジトリのルートで実行します。

```bash
mise run dev
```

表示されたURLをブラウザで開きます。`sample-content/content/` のMarkdownを編集して保存すると、プレビューに反映されます。

## 自分の資料を開く

```bash
mise run edit ../my-docs
```

docs root の構造は[フォルダー構成](doc:layout)を参照してください。

## 最初の編集

1. `content/guide.md` の冒頭の文章を変更します。
2. 保存し、プレビューで変更を確認します。
3. 左のツリーから[執筆ガイド](doc:writing)を開きます。

:::callout[編集を始める前に]
- このサンプルへの変更はファイルに保存されます。
- 元の例を残したい場合は、sample-content を別の場所にコピーしてください。
:::
