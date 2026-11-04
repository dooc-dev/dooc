---
title: "はじめに"
lang: "jpn"
---


## 起動する

リポジトリのルートで実行します。

```bash
mise run edit
```

表示されたURLを開き、本文を編集して保存します。変更は `sample-content/` 内のファイルに反映されます。

## 構成を知る

```text
sample-content/
  docs.config.mjs       # 既定の言語
  manifest.yaml         # 目次と表示順
  content/              # 本文
    guide.md
    writing.md
    media.md
    publishing.md
  figures/              # SVG・HTML
  examples/             # 掲載するコード
```

本文は `content/<id>.md` に置きます。ページの親子関係は `manifest.yaml` で指定します。

:::textfile(manifest.yaml)

## 次に読む

- [書き方](doc:writing)：Markdown・ファイル参照・用語。
- [図とデータ](doc:media)：関係図・スキーマ・SVG・HTML。
- [書き出し](doc:publishing)：HTML・JSON・ZIPで共有。
