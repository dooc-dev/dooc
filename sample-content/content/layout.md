---
title: "フォルダー構成"
lang: "jpn"
description: "ファイルの配置と3階層の目次の作り方。"
---

## 資料の置き場所

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

| 場所 | 役割 |
| --- | --- |
| `content/<id>.md` | 本文。ファイル名が文書IDになる |
| `manifest.yaml` | サイドバーの階層と表示順 |
| `figures/` | SVG・画像・HTML断片 |

## 3階層の目次

ファイルをフォルダーに分けなくても、manifest で親子関係を定義できます。このページは「ドキュメントガイド → はじめに → フォルダー構成」の3階層目です。

```yaml
- guide:
    - getting-started:
        - layout
```

文書へのリンクは `[はじめに](doc:getting-started)` と書きます。ページの表示名を変えても、文書IDを変えなければリンクを維持できます。
