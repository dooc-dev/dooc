---
title: "記法一覧"
lang: "jpn"
description: "本文にリソースを埋め込むための最小例。"
---

## 文書と図

```
[はじめに](doc:getting-started)

:::figure(overview.svg)[全体像]

:::html(pipeline.html)
```

## テキストファイル

```md
:::textfile(examples/hello.rs)
```

docs root からの相対パスを指定すると、右上の枠線上にファイル名が入った透過の枠で表示します。拡張子から言語を判定し、未登録の拡張子は通常のテキストとして表示します。[執筆ガイド](doc:writing)でRustファイルの表示例を確認できます。

末尾に範囲を指定すると、必要な部分だけを表示できます。

| 指定 | 表示する範囲 |
| --- | --- |
| `[1,3]` | 1行目から3行目まで |
| `[1,*]` | 1行目からファイルの末尾まで |
| `[1:5,7:3]` | 1行目の5文字目から7行目の3文字目まで |
| `["AAAA","BBB"]` | 最初のAAAAから、その後の最初のBBBまで |
| `["aaa",*]` | 最初のaaaからファイルの末尾まで |

```md
:::textfile(examples/hello.rs)[2,3]
:::textfile(examples/hello.rs)["println!", *]
```

行・文字位置は1始まりで、終点の文字や一致した文字列も含みます。文字位置はUnicodeコードポイントで数えます。文字列は大文字・小文字を区別し、行番号や文字位置、`*` と組み合わせられます。範囲が逆順、位置が範囲外、または文字列が見つからない場合はエラーになります。展開エディタでは元ファイル全体を編集します。

枠にカーソルを合わせると元の指定が表示されます。HTTP(S) URLもそのまま指定でき、同じ範囲指定を使えます。

```md
:::textfile(https://example.com/src/hello.rs)[1,3]
:::textfile(https://github.com/owner/repo/blob/main/src/hello.rs)
:::textfile(https://example.com/repo.git#main:src/hello.rs)["fn main", *]
```

Git URLは `https://ホスト/リポジトリ.git#ref:ファイルパス` の形式です。`ref` はブランチ・タグ・コミットを指定します。リポジトリURLとブランチだけではファイルを特定できません。公開リポジトリとGitコマンドが必要です。

URL参照は読み取り専用で、取得結果を1分間保持します。展開エディタの再読込で即時更新できます。取得には時間制限があり、リモートファイルの上限は2 MiBです。存在しないファイルや取得失敗は案内表示に切り替わり、文書の表示・出力は続行します。出力JSON/HTMLには取得した内容が入り、ソースZIPにはURLを残します。

## 関係図

```
:::graph[依存関係]
[viewer]: 閲覧画面
[compiler]: コンパイラ
[viewer] -> [compiler]
:::
```

## スキーマ

```
:::schema[文書と執筆者]
authors:
  id: pk
  name: string
documents:
  id: pk
  author_id: fk(authors)
  title: string
:::
```

型には `pk`、`fk(table)`、`fk[](table)`、`enum("a"|"b")`、`string`、`number`、`bool`、`json`、`timestamp` を使えます。

## 注意書きと用語

```
:::callout[確認事項]
- 参照先のファイルが存在することを確認します。
:::

:::term(docs-root)
name: "docs root"
definition: "文書・図・HTMLの説明図をまとめたルートフォルダー。"
description: "資料の入力先。" # 省略可
:::
```

用語は各記事の本文中の好きな場所で宣言し、本文では `:::term(docs-root)` のようにIDで参照します。同じ単語を書くだけではリンクになりません。宣言は自動収集され、一覧と並べ替えは Resources → Terms にあります。
