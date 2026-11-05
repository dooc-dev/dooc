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
  manifest.yaml         # 既定言語・目次・サイト設定
  content/              # 本文
    guide.md
    writing.md
    media.md
    publishing.md
  icons/                # サイト・ページのアイコン
  figures/              # SVG・HTML
  examples/             # 掲載するコード
  terms/                # 用語ファイル
  files/                # 拡張子ごとの配置
    csv/review.csv
```

このサンプルの本文は `content/` にあります。Filesで移動・名前変更しても、文書のURLとリンクは維持されます。ページの親子関係は `manifest.yaml` で指定します。

![](manifest.yaml)

## Filesから追加する

ファイルをブラウザへドラッグすると、サイドバーのFiles欄にドロップ先が表示されます。Files欄にドロップするか、見出し右側のアップロードボタンからファイルを選びます。複数ファイルに対応し、1ファイルの上限は64 MiBです。

このサンプルではDefault folder layoutが有効です。追加したファイルは、CSVなら `files/csv/`、画像なら `files/png/` のように拡張子ごとのフォルダに保存されます。同名ファイルには連番が付きます。設定を無効にした場合はルートに保存されます。

Filesを開くと、拡張子による絞り込み、パスのコピー、複数選択での移動ができます。Folder restructureは本文のMarkdownも含めて拡張子ごとに整理し、ファイル参照を更新します。サイドバーのFiles欄は下端をドラッグして高さを変えられます。

## 次に読む

- [書き方](doc:writing)：Markdown・ファイル参照・用語。
- [図とデータ](doc:media)：関係図・スキーマ・SVG・HTML。
- [書き出し](doc:publishing)：HTML・JSON・ZIPで共有。
