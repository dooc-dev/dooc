---
title: "フォルダー構成"
description: "ファイルの配置と3階層の目次の作り方。"
lang: "jpn"
---

## 資料の置き場所

:::term(docs-root)
name: "docs root"
definition: "content/、figures/、icons/ をまとめた、コンパイラへの入力となるフォルダー。"
description: "資料の入力フォルダー。"
:::

```
sample-content/
  manifest.yaml
  content/
    guide.md
    getting-started.md
    layout.md
  figures/
    overview.svg
    pipeline.html
    intro.html
```

| 場所              | 役割                           |
| ----------------- | ------------------------------ |
| `content/<id>.md` | 本文。ファイル名が文書IDになる |
| `manifest.yaml`   | サイドバーの階層と表示順       |
| `figures/`        | SVG・画像・HTML断片            |

:::term(doc-id)
name: "文書ID"
definition: "Markdownファイル名から拡張子を除いた識別子。doc: リンクの参照先として使う。"
:::

## 3階層の目次

:::term(manifest)
name: "manifest"
definition: "文書の親子関係と表示順を定める manifest.yaml。"
:::

ファイルをフォルダーに分けなくても、manifest で親子関係を定義できます。このページは「ドキュメントガイド → はじめに → フォルダー構成」の3階層目です。

```yaml
title: "Document System"
docs:
  - guide:
      - getting-started:
          - layout
```

`title` はサイト全体のタイトルで、左上とブラウザのタブに表示されます。

文書へのリンクは `[はじめに](doc:getting-started)` と書きます。ページの表示名を変えても、文書IDを変えなければリンクを維持できます。
