---
title: "書き方"
lang: "jpn"
---

1ページに1つの話題をまとめ、見出しで区切ります。

## Markdown

ページのタイトルは先頭の `title`、本文の見出しは `##` で指定します。

```md
## 手順

1. 本文を書く。
2. 保存して表示を確認する。

**強調**と `コード` を使えます。
[はじめに](doc:guide)へ戻ります。
```

`doc:<id>` で他のページを参照します。IDはMarkdownのファイル名から拡張子を除いたものです。

## ファイル参照

`:::textfile(examples/hello.rs)` で、ルートからの相対パスにあるファイルを表示します。

:::textfile(examples/hello.rs)

末尾に `[2,2]` を付けると2行目だけを表示します。エディタでは参照行のボタンから元ファイルを開けます。

## 注意書き

:::callout[書き終えたら]
- リンク先とプレビューを確認します。
- 使わない説明や例を削ります。
:::

## 用語

:::term(docs-root)
name: "docs root"
definition: "manifest.yaml と content/ を置く、文書一式のルートフォルダー。"
description: "資料の入力フォルダー。"
:::

`:::term(docs-root)` と書くと、:::term(docs-root) の説明を参照できます。宣言した用語はリソース一覧にも表示されます。
