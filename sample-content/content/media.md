---
title: "図とデータ"
lang: "jpn"
---

流れは関係図、データの関連はスキーマで表します。SVGとHTMLは `figures/` に置きます。

## 関係図

`:::graph` の中でノードを定義し、`->` でつなぎます。

:::graph[文書を共有する流れ]
[write]: 書く
[check]: 確認する
[share]: 共有する
[write] -> [check]
[check] -> [share]
:::

## スキーマ

架空の執筆者と文書のモデルです。`pk` は主キー、`fk(authors)` は執筆者への参照を表します。

:::schema[執筆者と文書]
authors:
  id: pk
  name: string

documents:
  id: pk
  author_id: fk(authors)
  title: string
:::

## SVG

`:::figure(overview.svg)[入力と出力]` で図と説明を表示します。

:::figure(overview.svg)[入力と出力]

## HTML

`:::html(note.html)` でHTML断片を表示します。下の補足はクリックやキーボードで開閉できます。

:::html(note.html)
