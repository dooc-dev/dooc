---
title: "データモデル"
lang: "jpn"
description: "チーム・執筆者・文書の関係を表すスキーマ例。"
---

この図はスキーマ表示を試すための架空のモデルです。document-pkg が実際に利用するデータベース構造ではありません。

## 執筆チームのモデル

:::schema[チームと文書の関連]
### チーム
teams:
  id: pk
  name: string

authors:
  id: pk
  team_id: fk(teams)
  name: string

### コンテンツ
documents:
  id: pk
  author_id: fk(authors)
  title: string
  status: enum("draft"|"review"|"published")
  updated_at: timestamp

revisions:
  id: pk
  document_id: fk(documents)
  body: string
  created_at: timestamp
:::

## モデルの読み方

| 関係 | 意味 |
| --- | --- |
| teams → authors | チームに執筆者が所属する |
| authors → documents | 執筆者が文書を担当する |
| documents → revisions | 文書ごとに改訂履歴を保持する |

`pk` は主キー、`fk(...)` は参照先のテーブルを表します。利用できる型は[記法一覧](doc:syntax)で確認できます。
