---
title: "処理フロー"
description: "資料の読み込みから検証・配布まで。"
lang: "jpn"
---

## 入力から配布まで

:::graph[ドキュメントの変換フロー]
[content]: Markdown・目次
[assets]: 図・HTMLの説明図
[compile]: 読み込み・検証
[artifact]: artifact
[viewer]: ブラウザで閲覧
[export]: HTMLとして配布
[content] -> [compile]
[assets] -> [compile]
[compile] -> [artifact]
[artifact] -> [viewer]
[artifact] -> [export]
:::

## 検証する内容

コンパイラは文書の構造や参照先を検証します。存在しない文書IDや図を参照している場合は、エラーを修正してから書き出します。

:::html(pipeline.html)

## 関連資料

[フォルダー構成](doc\:layout)で入力の配置を、[書き出し](doc\:publishing)で成果物の作成方法を確認できます。
