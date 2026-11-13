# dooc 依存ライセンス調査

> Historical snapshot — 2026-11-12. This document and the linked dependency inventory preserve the original audit. All counts, versions, findings, and references to the current state below refer to that date. This migration does not refresh the inventory or establish compliance for the current release. Repository source links point to the current file locations, whose contents may differ from the audited revision.

調査日: 2026-11-12。dooc 自作部分の候補は **MIT**。改変版を配布する人にもソース提供を求めたい場合は GPLv3 が候補になる。ただし、どちらを選んでも第三者のコード・辞書・フォントの条件は残る。今回の棚卸しは配布物全体の適合完了を意味しない。

## 対象と確認範囲

- 対象: `@dooc-dev/dooc@0.0.6` の現在の作業ツリー、`package.json`、`pnpm-lock.yaml`、インストール済みパッケージ、ビルド・配布処理。
- 基準コミット: `08a758caf4dd64d6ec9f922d9d4d4c9061a979dd`。調査時の未コミット変更を含む。
- lockfile SHA-256: `48d082bbe156103999f85af858b5a1990ecfa2dd4675d758e38145025c9afde9`。
- pnpm: `10.28.2`。件数は同名でもバージョンが異なれば別件とする。
- lockfile の **787件**を[依存一覧 CSV](contents/csv/dependency-licenses.csv)に記録した。うち **708件**はローカルの package.json を確認し、**79件**は別OS・CPU向け等の未導入パッケージとして未確認扱いにした。
- 直接依存は `dependencies` **28件**、`devDependencies` **27件**。任意 peer の React・React DOM・XYFlow は開発依存にある実バージョンを数えた。peer の許容範囲全体を検証したものではない。
- `pnpm licenses list --prod` の対象は **427件**。ただし配布対象はこの集合だけではない。
- `package.json` の7つのブラウザ向けエントリを esbuild でメモリ上にバンドルし、metafile の `bytesInOutput > 0` を確認した。**194件**がJS出力に寄与し、うち **103件**は上記の production 集合に含まれない。

CSV の `declared_license` はパッケージの申告値であり、全ソースの権利確認結果ではない。`license_file_override` は原文確認で補足した値。`license_files` は `package_directory` 直下にある LICENSE・NOTICE 等のファイル名であり、存在確認と全文の手動審査は異なる。`browser_bundles` は確認したJS出力への組み込み先で、空欄でもサーバー・バイナリ・CSS・データに含まれないとは限らない。未導入79件のライセンスは推測で埋めていない。

## 直接依存の整理

| 区分 | ライセンス | パッケージ |
| --- | --- | --- |
| dependencies | MIT、26件 | `@dagrejs/dagre`、`@shikijs/langs`、`@textlint/kernel`、`@textlint/module-interop`、`@textlint/textlint-plugin-markdown`、`ajv`、`ajv-formats`、`dxf`、`franc`、`ignore`、`iso-639-3`、`parse5`、`postcss`、`postcss-value-parser`、`remark-frontmatter`、`remark-gfm`、`remark-parse`、`remark-stringify`、`shiki`、`string-width`、`textlint-rule-preset-ja-technical-writing`、`toml-eslint-parser`、`unified`、`unist-util-visit`、`vscode-json-languageservice`、`vscode-languageserver-textdocument` |
| dependencies | BSD-3-Clause | `smol-toml@1.9.1` |
| dependencies | ISC | `yaml@2.9.1` |
| devDependencies | MIT、24件 | CodeMirror・Lezer各種、`@shikijs/themes`、`@types/*`、`@xyflow/react`、`esbuild`、`mermaid@12.3.0`、`react`、`react-dom`、`textlint`、`tsx`、`vitest`。全件の固定バージョンはCSVを参照 |
| devDependencies | BSD-3-Clause | `diff@8.0.4` |
| devDependencies | Apache-2.0 | `typescript@5.9.3` |
| devDependencies | MIT OR Apache-2.0 | `@biomejs/biome@2.4.15` |

Mermaid・CodeMirror・React・XYFlow・diff等は開発依存でもバンドルに含まれるため、第三者通知の対象から一括で除外しない。

## 間接依存を含む集計

インストール済み708件の申告値を基準とし、`khroma` 1件のみライセンス原文からMITに補正した。`OR` は選択可能な条件を表し、両方が同時に必須という意味ではない。

| ライセンス | 全体 | production 集合 |
| --- | ---: | ---: |
| MIT | 604 | 408 |
| ISC | 52 | 6 |
| BSD-3-Clause | 19 | 6 |
| Apache-2.0 | 14 | 2 |
| BSD-2-Clause | 5 | 4 |
| BlueOak-1.0.0 | 5 | 0 |
| MIT OR Apache-2.0 | 2 | 0 |
| MPL-2.0 OR Apache-2.0 | 1 | 0 |
| Python-2.0 | 1 | 1 |
| Unlicense | 1 | 0 |
| WTFPL | 1 | 0 |
| CC-BY-3.0 | 1 | 0 |
| CC0-1.0 | 1 | 0 |
| MIT OR CC0-1.0 | 1 | 0 |
| 合計 | 708 | 427 |

フォント・辞書の別条件やBun内部のライブラリはこのnpm集計に含まれない。

## 配布前に対応すべき依存物

### elkjs は依存ツリーと dooc のバンドルから除去済み

初回調査では `mermaid@12.3.0 → elkjs@0.12.1` が図表JSに含まれていた。elkjsの条件は `EPL-2.0 OR GPL-3.0-or-later`。現在は[固定バージョンへのパッチ](https://github.com/dooc-dev/dooc/blob/main/patches/mermaid@12.3.0.patch)でELKのローダー登録を外し、pnpmのoverrideでelkjs依存も削除した。Mermaid自体はMITのまま使用する。

MermaidはブラウザJSのビルド時にのみ使うため開発依存へ移した。公開npmパッケージのproduction依存からも外れ、npm側がpnpmパッチを適用せず元のMermaidとelkjsを導入することを避けている。doocの配布物はパッチ適用済みのソースから `pnpm build` で作成する。

[初期設定](https://github.com/dooc-dev/dooc/blob/main/packages/frontend/src/mermaid-mount.ts)は `layout: "dagre"`。mindmap・architecture・KaTeX等の機能は削除していない。ELKを明示した図もMermaid既存のDagreへのフォールバックで描画するが、配置やELK固有オプションの効果は変わる。IIFE・分割ESMの両方でelkjsを読み込まないことを[テスト](https://github.com/dooc-dev/dooc/blob/main/packages/frontend/src/mermaid-mount.test.ts)で検証する。Mermaidの更新時はパッチを再確認する必要がある。

公式の軽量版はELKと一緒にmindmap・architecture・数式表示も省くため、今回は使っていない。[Mermaid公式の説明](https://mermaid.js.org/config/usage#tiny-mermaid)

### Bun バイナリには npm 外の条件がある

[バイナリのワークフロー](https://github.com/dooc-dev/dooc/blob/main/.github/workflows/binaries.yml)はBun `1.4.4`を使用し、[ビルド処理](https://github.com/dooc-dev/dooc/blob/main/scripts/build/binary.mjs)は実行環境込みの実行ファイルを作る。

Bun自体はMITだが、公式資料はJavaScriptCore/WebKitのLGPL、静的リンクと再リンクのための対応を説明し、TinyCCのLGPL v2.1など他の同梱ライブラリも列挙している。対象バージョン・各OSの実配布物について、通知、対応ソース、改変したライブラリで再構築できる条件を確認する必要がある。doocをMITにすればこれらが不要になるわけではない。[Bun公式ライセンス説明](https://bun.sh/docs/project/license)

### kuromoji と辞書は別のライセンス

`textlint-rule-preset-ja-technical-writing → 各ルール → kuromojin → kuromoji@0.1.2` の経路で導入される。kuromoji本体はApache-2.0だが、同梱の `mecab-ipadic-2.7.0-20070801` にはNAIST/ICOTの条件がある。

`kuromoji/NOTICE.md` に辞書の著作権と条件の全文がある。内容は [NAIST-2003](https://spdx.org/licenses/NAIST-2003.html) に対応し、コピーには表示・条件文の保持が求められる。[バイナリのビルド処理](https://github.com/dooc-dev/dooc/blob/main/scripts/build/binary.mjs)は `dict/*.dat.gz` を埋め込むが、このNOTICEをアセットに加える処理はない。辞書を配布する箇所にNOTICE全文とkuromojiのApacheライセンスを届ける必要がある。

### UDEV Gothic は OFL-1.1

[既存のフォントライセンス](https://github.com/dooc-dev/dooc/blob/main/packages/server/src/fonts/LICENSE.txt)にはUDEV Gothic v2.2.0の由来、OFL本文、元フォントの著作権表示がある。[fontCss](https://github.com/dooc-dev/dooc/blob/main/packages/server/src/fonts.ts)は単体HTML向けのCSSにこの本文を埋め込む。

フォントの条件はOFLのまま保持する。dooc本体やユーザーが書いた文章をOFLにする必要はない。現在のWOFF2はTTFから変換した旨が記録されているため、予約フォント名の扱いに関わる元データ・メタデータの保持を確認する。変換結果と元TTFの比較は未実施。[OFL原文](https://openfontlicense.org/open-font-license-official-text/)、[OFL FAQ 2.2](https://openfontlicense.org/ofl-faq/#2-2-can-i-make-and-use-woff-web-open-font-format-versions-of-ofl-fonts)

### その他の選択ライセンスとデータ

- `dompurify@3.4.17`: `MPL-2.0 OR Apache-2.0`。図表JSに含まれる。MIT方針ではApache-2.0側を選び、その表示・配布条件を保持する整理が可能。
- `khroma@2.1.0`: Mermaid経由。package.jsonにlicenseがなくpnpmではUnknownになるが、同梱の `license` ファイルはMIT。CSVには申告値を空欄のまま残し、原文確認値を別欄に記録した。
- `spdx-exceptions@2.5.0`: `CC-BY-3.0`。今回のproduction集合・7つのブラウザJS出力にはない。将来同梱する場合は、データの帰属表示・ライセンスへの案内等も収集対象にする。[CC BY 3.0条件](https://creativecommons.org/licenses/by/3.0/)
- `@shikijs/langs@4.5.0`、`@shikijs/themes@4.5.0`: パッケージ本体の表示はMIT。ただし文法・テーマの個別上流に関する権利表示の棚卸しは未完了。[上流の収集元](https://github.com/shikijs/textmate-grammars-themes)と対象バージョンを照合する必要がある。[文法のロード処理](https://github.com/dooc-dev/dooc/blob/main/packages/engine/src/compiler/code-languages.ts)はJSONとして書き出すため、JSコメントの保持だけで通知が足りるとは判断しない。

## 現行の配布処理で不足している確認

| 配布経路 | 現状と次の対応 |
| --- | --- |
| ソース・npm | ルートのLICENSEと両package.jsonのlicense欄が未設定。方針決定後に著作権者を確認して設定する。`files: ["dist"]` に含まれるバンドルについて、第三者通知をnpm tarballに届ける |
| 単体バイナリ | ワークフローのtarは `dooc` 実行ファイルのみを格納する。フォントLICENSEは埋め込まれるが、依存物全体の通知・ソース入手案内の収集処理は確認できない。Bun内部も含めて用意し、インストール後も利用者が読める形にする |
| HTML・ブラウザJS | フォントには本文埋め込みがある。ELK除去後もMermaid等を含むため、各ライセンス本文、必要なNOTICE・著作権表示が生成HTMLにも届くことを確認する。esbuildが一部のコメントを残すことだけでは全文通知の証明にならない |
| Homebrew | [Formula](https://github.com/dooc-dev/dooc/blob/main/Formula/dooc.rb)のlicense欄が未設定。方針決定後に実際の配布内容に合わせて記載し、通知もインストール先に届ける |
| dooc-plugin | [別npmパッケージ](https://github.com/dooc-dev/dooc/blob/main/plugins/package.json)には直接依存の宣言がない。本体とは別にLICENSEと公開tarballへの同梱を扱う |

この表の通知・ソース提供への対応は未実装。ユーザーが追加するプラグイン、独自フォント・文法、文書・画像・外部URLから埋め込むコンテンツの権利は、この固定依存の棚卸しとは別に管理する。

## dooc 本体の選択肢

| 候補 | 向いている意図 | doocでの考慮点 |
| --- | --- | --- |
| MIT | 広く使ってもらい、商用利用・非公開の改変版も許可したい | 著作権・許諾表示の保持が中心。今回の第一候補。第三者部分は元の条件を保持する |
| Apache-2.0 | 広い再利用に加え、貢献者からの特許許諾を明記したい | 特許条項、変更表示、該当するNOTICEの保持などMITより条件が多い |
| GPL-3.0-only / GPL-3.0-or-later | 対象となる改変版・結合物を配布する人にもソース提供等を求めたい | 単なる非公開利用に一律の公開義務はない。プラグインと、doocのJSを含む生成HTMLの配布範囲を整理する必要がある |
| GPL-2.0-only | 今回は非推奨 | Apache-2.0の依存との結合で非互換の問題がある。GPLを選ぶならv3を軸にする |

MIT・Apache-2.0・GPLv3はいずれもOSSとして使える選択肢で、GPLも商用利用・有償配布を禁止するものではない。単に「OSSにしたい」だけならGPLを選ぶ必然性はない。[MIT原文](https://opensource.org/license/mit)、[Apache-2.0原文](https://www.apache.org/licenses/LICENSE-2.0)、[GPLv3原文](https://opensource.org/license/GPL-3.0)、[ApacheとGPLの互換性](https://www.apache.org/licenses/GPL-compatibility.html)

doocでは生成HTMLに実行用JSを含めるため、MITは利用者の再配布条件を整理しやすいと考える。GPLを選んでも、利用者の文章がツールを使っただけで自動的にGPLになるとは扱わない。一方、HTML内にコピーされたdoocコードは別途GPLの対象として検討する必要がある。

本体の選択は **MITを第一候補として、第三者通知とLGPL等への対応を併せて整える**。今回の確認では、自作コード全体をGPLにする選択だけを強制する依存は特定していないが、Bunの配布条件や文法・テーマの個別条件を含む最終確認は残る。

## 検証と更新

棚卸しの基礎データは次の既存コマンドで取得した。CSVは固定バージョン、申告値、ローカルのライセンスファイル名、バンドルへの組み込み結果を合わせた調査スナップショットである。

```sh
pnpm licenses list --json
pnpm licenses list --prod --json
pnpm list --depth Infinity --json
```

lockfile全787件との一対一の対応、導入済み708件のバージョン一致、elkjsの除去、khromaの補正をassertで確認した。直接依存は28件、開発依存は27件。7つのブラウザエントリのバンドルと `pnpm build`、型チェック、関連27テストは成功した。ブラウザではflowchart・sequence・mindmap・architecture・class・state・ER・requirement・blockとELK明示指定の10ケースを描画できた。

Linux x64の `pnpm build:binary` と `pnpm test:binary` は成功した。npm packのdry-runでも、両形式の図表バンドルを含み、Mermaidがproduction依存にないことを確認した。

各OS向けの配布バイナリ・npm tarball・生成HTMLを使った最終的な通知とソース提供の検証、未導入79件の原文確認、全ソースの来歴確認は未実施。アプリの全テストは実行していない。依存更新時にはこのスナップショットを更新する。
