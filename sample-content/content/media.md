---
title: "図とHTML"
lang: "jpn"
description: "SVGの構成図とHTMLによるステータス表示。"
---

## SVGの構成図

SVGは、拡大しても文字や線がぼやけない図に適しています。

:::figure(overview.svg)[入力から表示までの全体像]

```
:::figure(overview.svg)[入力から表示までの全体像]
```

## HTMLの処理フロー

HTML断片では、CSSで配置や状態を表現できます。以下は保存から表示までの流れを説明する模式図です。実際の処理状態と連動するものではありません。

:::html(pipeline.html)

```
:::html(pipeline.html)
```

## リソースを選ぶ

| 形式 | 用途 |
| --- | --- |
| SVG / drawio.svg | 構成図、説明図 |
| PNG / WebP / JPEG | スクリーンショット、写真 |
| HTML断片 | 本文に埋め込む表示 |

HTMLの説明図はリソース一覧の HTML → intro.html から確認できます。図の参照は Fig. overview のように本文にも書けます。
