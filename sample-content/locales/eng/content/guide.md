---
title: "はじめに"
lang: "eng"
---

Markdownで文書を書き、ブラウザで確認し、ファイルとして共有するサンプルです。

## 起動する

リポジトリのルートで実行します。

```bash
mise run edit
```

表示されたURLを開き、本文を編集して保存します。変更は `sample-content/` 内のファイルに反映されます。

## 構成を知る

```text
sample-content/
  dooc.yaml             # Default language, navigation and site settings
  content/              # Documents
    guide.md
    writing.md
    media.md
    publishing.md
  locales/eng/content/  # English translations
  icons/                # Site and page icons
  figures/              # SVG and HTML
  examples/             # Source code
  terms/                # Terms
  files/                # Files grouped by extension
    csv/review.csv
```

このサンプルの本文は `content/` にあります。Filesで移動・名前変更しても、文書のURLとリンクは維持されます。ページの親子関係は `dooc.yaml` で指定します。

翻訳も通常のMarkdownファイルです。例えば `content/guide.md` の英語版は `locales/eng/content/guide.md` に置きます。翻訳がない文書は原文を表示し、目次と設定は `dooc.yaml` を共有します。

![](dooc.yaml)

## Filesから追加する

ファイルをブラウザへドラッグすると、サイドバーのFiles欄にドロップ先が表示されます。Files欄にドロップするか、見出し右側のアップロードボタンからファイルを選びます。複数ファイルに対応し、1ファイルの上限は64 MiBです。

このサンプルではDefault folder layoutが有効です。追加したファイルは、CSVなら `files/csv/`、画像なら `files/png/` のように拡張子ごとのフォルダに保存されます。同名ファイルには連番が付きます。設定を無効にした場合はルートに保存されます。

Filesを開くと、拡張子による絞り込み、パスのコピー、複数選択での移動ができます。Folder restructureは本文のMarkdownも含めて拡張子ごとに整理し、ファイル参照を更新します。サイドバーのFiles欄は下端をドラッグして高さを変えられます。

## 次に読む

- [書き方](content/writing.md)：Markdown・ファイル参照・用語。
- [図とデータ](content/media.md)：関係図・スキーマ・SVG・HTML。
- [書き出し](content/publishing.md)：HTML・ZIPで共有。
