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

`doc:<id>` で他のページを参照します。IDは `manifest.yaml` の目次にある識別子です。ファイル名を変更しても、IDとリンク先は維持されます。

## ファイル参照

`![](examples/hello.rs)` で、ルートからの相対パスにあるファイルを表示します。

![](examples/hello.rs)

`![](examples/hello.rs#L2)` で2行目だけを、`![](examples/hello.rs#L2-L3)` で2〜3行目を表示します。エディタでは参照行のボタンから元ファイルを開けます。

コードブロックのファイル作成ボタンから内容をファイルに切り出せます。Default folder layoutが有効な場合は、保存先を自動で決め、本文をファイル参照に置き換えます。

## 注意書き

:::callout[書き終えたら]
- リンク先とプレビューを確認します。
- 使わない説明や例を削ります。
:::

## 用語

```termth
name: "preview"
definition: "公開前に確認する表示結果。"
```

`terms/docs-root.termth` に用語のYAMLを保存し、`[](terms/docs-root.termth)` と書くと、[](terms/docs-root.termth) の説明を参照できます。用語ファイルもFilesで管理できます。
