---
title: "記法一覧"
lang: "jpn"
description: "本文にリソースを埋め込むための最小例。"
---

## 文書と図

```
[はじめに](doc:getting-started)

:::figure(overview.svg)[全体像]

:::html(pipeline.html)
```

## 関係図

```
:::graph[依存関係]
[viewer]: 閲覧画面
[compiler]: コンパイラ
[viewer] -> [compiler]
:::
```

## スキーマ

```
:::schema[文書と執筆者]
authors:
  id: pk
  name: string
documents:
  id: pk
  author_id: fk(authors)
  title: string
:::
```

型には `pk`、`fk(table)`、`fk[](table)`、`enum("a"|"b")`、`string`、`number`、`bool`、`json`、`timestamp` を使えます。

## 注意書きと用語

```
:::callout[確認事項]
- 参照先のファイルが存在することを確認します。
:::

:::dictionary
- term: "docs root"
  definition: "文書・図・HTMLの説明図をまとめたルートフォルダー。"
:::
```

用語は[用語集](doc:dictionary)でまとめて定義し、各ページの本文で使います。
