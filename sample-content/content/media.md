---
title: "図・HTML・動画・音声"
lang: "jpn"
description: "図やHTMLに加えて、外部サイト・MP4動画・WAV音声を埋め込む。"
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

## 外部サイトを埋め込む

HTML断片に iframe を書くと、外部URLのページを表示できます。この例は OpenStreetMap の地図です。

:::html(external-iframe.html)

```
:::html(external-iframe.html)
```

埋め込み先のサイトが表示を許可している必要があります。HTML断片は sandbox 内で表示されるため、ログインやフォームなどの機能には制限があります。

## MP4動画を再生する

HTML断片の video 要素で外部のMP4を参照します。再生ボタンを押すと、MDNの花のサンプル動画が再生されます。自動再生はしません。

:::html(external-video.html)

```
:::html(external-video.html)
```

## WAV音声を再生する

WAVは音声ファイルです。HTML断片の audio 要素で参照し、再生ボタンを押してMDNのサンプル音声を確認できます。

:::html(external-audio.html)

```
:::html(external-audio.html)
```

これらの例にはインターネット接続が必要です。HTMLやJSONの出力には外部URLが残り、動画・音声ファイル自体は同梱されません。ローカルのMP4・WAVを figures/ に置くだけでは取り込まれません。

## リソースを選ぶ

| 形式 | 用途 |
| --- | --- |
| SVG / drawio.svg | 構成図、説明図 |
| PNG / WebP / JPEG | スクリーンショット、写真 |
| HTML断片 | 本文に埋め込む表示 |

HTMLの説明図はリソース一覧の HTML → intro.html から確認できます。図の参照は Fig. overview のように本文にも書けます。
