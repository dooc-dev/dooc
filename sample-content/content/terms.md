---
title: "用語の使い方"
lang: "jpn"
description: "記事の本文で宣言した用語をIDで参照する。"
---

用語は、関連する記事の本文中の好きな場所で宣言できます。宣言は自動収集され、Resources → Terms に一覧として表示されます。一覧への手動登録は不要です。

このサンプルでは、[フォルダー構成](doc:layout)、[設計資料](doc:architecture)、[データモデル](doc:data-model)、[書き出し](doc:publishing)に宣言を分けています。

## 本文で参照する

:::term(docs-root) を :::term(compiler) が読み込み、:::term(artifact) を出力します。

```
:::term(docs-root) を :::term(compiler) が読み込み、:::term(artifact) を出力します。
```

同じ単語を書くだけではリンクになりません。用語の一覧と並べ替えは Resources → Terms から確認できます。
