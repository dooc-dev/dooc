---
title: "図とデータ"
lang: "mij"
---

流れは関係図、データの関連はスキーマで表します。CSV・画像・HTMLはFilesから取り込み、`![](ファイルへの相対パス)` で表示します。

## 関係図

`grapth` の中でノードを定義し、`->` でつなぎます。

```grapth 文書を共有する流れ
[write]: 書く
[check]: 確認する
[share]: 共有する
[write] -> [check]
[check] -> [share]
```

## スキーマ

架空の執筆者と文書のモデルです。`pk` は主キー、`fk(authors)` は執筆者への参照を表します。

~~~schemath 執筆者と文書
authors:
  id: pk
  name: string

documents:
  id: pk
  author_id: fk(authors)
  title: string
~~~

## CSV

CSVもFilesから取り込めます。ファイルのパスをコピーし、`![](files/csv/review.csv)` のように書くと内容を参照できます。

![](files/csv/review.csv)

## SVG

`![入力と出力](figures/overview.svg)` で図と説明を表示します。

![入力と出力](figures/overview.svg)

## HTML

`![](figures/note.html)` でHTML断片を表示します。下の補足はクリックやキーボードで開閉できます。

![](figures/note.html)
