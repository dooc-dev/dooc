---
title: "設計資料"
lang: "jpn"
description: "文書の入力・変換・表示と、サンプルのデータモデル。"
---

## システムの責務

:::term(compiler)
name: "コンパイラ"
definition: "資料のファイルを読み込み、構造と参照を検証して、表示・配布用のデータに変換する処理。"
:::

文書の管理と表示を分けることで、同じ資料をブラウザ閲覧とファイル配布に使えます。

:::graph[コンポーネントの依存関係]
[viewer]: 閲覧・編集 @app
[compiler]: コンパイラ @app
[core]: 表示・型定義 @lib
[viewer] -> [compiler]
[viewer] -> [core]
[compiler] -> [core]
:::

| コンポーネント | 主な役割 |
| --- | --- |
| viewer | リクエストに応じて文書を表示し、編集を受け付ける |
| compiler | 本文と参照を検証し、artifact に変換する |
| core | 共通の型、リンク、描画処理を提供する |

## 詳細設計

- [処理フロー](doc:flow)：入力から配布までの流れ。
- [データモデル](doc:data-model)：執筆チームを題材にしたスキーマの例。
