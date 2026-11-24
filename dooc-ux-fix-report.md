# dooc UX修正レポート

2026-11-24 · 元の17項目と追加DnD、計18項目を対応。

[見比べやすいHTML版](dooc-ux-fix-report.html) · [元の監査](dooc-ux-audit-report.md)

## 対応結果

| # | 対象 | 変更内容 | 確認結果 |
| --- | --- | --- | --- |
| 1 | ペイン切り替え中のクリックが捨てられる | ペイン復元の通信を待たずに移動を受け付け、短い状態切替中も最後のクリックを保持。遅い復元結果は新しい表示へ反映しない。 | 別ペインの応答を保留してBetaをクリック。Betaの要求が1回発行され、保留解除後もBetaの表示と選択を維持。 |
| 2 | ナビの取得が本文解析を待っている | /api/navを本文のロード経路から分離。dooc.yaml、アイコン、言語の有無からナビを作り、本文コンパイルやリソース一覧を待たない。 | 本文コンパイラーの呼び出しが0回であることをテスト。別文書を10,000段落へ変更した直後のナビ取得は0.609ms。 |
| 3 | Gitの待ち時間がナビにも波及する | Nodeワークスペースの読み取りを、書き込みの間で並行実行。AbortSignalをHTTP・スコープ付きクライアント・通信プロトコルへ渡し、中止済みの待機要求を開始しない。 | Gitの応答を250ms保留したままナビが0.722msで完了。中止は直ちにAbortErrorとなり、後の応答でも成功へ戻らない。書き込み順序もテスト。 |
| 4 | 応答が逆転すると本文が古くなる | 本文更新に世代番号を付け、最新の結果だけ反映。更新中に届いた変更ファイルの集合も完了まで保持する。 | 古い応答を新しい応答より後に返しても「Newer external body.」を維持。文書変更に画像変更が重なる場合も、文書の更新通知を取りこぼさない。 |
| 5 | 「戻る」を重ねると途中で止まる | クリック・戻る・進むを同じキャンセル可能な移動処理へ統合。成功した最新の移動だけが表示と履歴を更新する。 | Gammaから2回戻るとAlpha、進むとBetaへ到達。履歴数は5のまま。FilesとLibraryの応答を逆転してもFilesのURLと画面が一致。 |
| 6 | 言語変更で2つ目のファイル一覧が消える | Filesの言語更新を同じ表示先で行い、ワークスペース・検索語・選択・フォルダー開閉を保持。再マウントしない。 | 別ワークスペースに紐づく2つのFilesペインが、言語変更後もそれぞれの内容を表示。片方の更新が他方へ混入しないことも確認。 |
| 7 | 移動中の選択表示が元へ戻る | 移動中のパスを明示的に保持し、ナビ再取得時もその行を選択。クライアントのURL接頭辞を選択の照合前に正規化する。 | 本文取得を保留してナビ更新を先に完了させても、選択・aria-currentともAlphaのまま。本文到着後も同じ選択を維持。 |
| 8 | 応答が逆転するとツリーの名称が戻る | ナビ再取得にも世代番号を付け、最後の要求だけがツリーとサイト名を更新する。 | 古いナビを後から返しても「Newer Beta」と「Newer title」が保持される。 |
| 9 | 項目が多いとsidebarの開閉が重い | サイドバー内部の幅を固定し、外側の幅変更中は行ごとの形状アニメーションを抑制。完了時に枝のアニメーションを戻し、連打による反転と動きの軽減設定にも対応。 | 400項目の最大フレーム間隔は50.1→16.8ms、1,000項目は116.7→33.4ms。枝の開閉は最大16.8ms。途中の寸法・反転・reduced motionをブラウザーテスト。 |
| 10 | 見た目と読み上げ向けの現在位置がずれる | ナビの選択クラスとaria-currentを同じ移動先から一緒に更新する。 | 遅延中・完了後・連続Back/Forwardで、見た目の選択とaria-currentが一致。 |
| 11 | フォルダーの開閉でフォーカスが消える | 一覧再描画前のファイルパスと操作部品を記録し、同じ操作部品へフォーカスを戻す。消えた行には親行などの代替位置を選ぶ。 | フォルダーをEnterで開閉後もBUTTON.files-folderにフォーカス。次のTabは次の操作へ進み、bodyへ落ちない。 |
| 12 | 本文リンクからの移動で操作位置を失う | 本文内から移動した場合は、移動先の見出し・フラグメントまたはmainへフォーカスを移す。ナビや他の操作部品へ移ったフォーカスは保持する。 | 閲覧画面の本文リンクをEnterで開くと、移動先のH1「beta heading」へフォーカスが移る。 |
| 13 | Git画面が外部の変更を反映しない | Git部品が対象ワークスペースの変更を購読。操作中は更新をまとめて後で処理し、入力中のメッセージ・カーソル・フォーカス・開閉状態を保持する。 | 外部保存したbeta.mdがReloadなしで一覧へ出現。コミットメッセージの下書きと選択位置を保った更新もテスト。 |
| 14 | 開いたままの検索結果が古くなる | 検索を開いている間も本文変更通知から検索データを更新。再取得中も現在のデータと検索語を維持し、入力へフォーカスを奪い直さない。 | 検索を閉じずに外部追加語「UniqueAuditFreshTerm」がヒット。入力語・フォーカスの保持もテスト。 |
| 15 | Filesを経由するとダーク設定が変わる | プレビューペインごとの文書テーマを保持し、ツール表示で一時的に使ったテーマから文書設定へ戻す。 | 文書dark → Files light → 文書darkを確認。保存値もdarkのまま。 |
| 16 | 拡大図をタッチ・キーで操作できない | 拡大・縮小・リセット、キー操作、タッチ移動・ピンチを追加。中ボタンのネイティブ動作を抑え、release・cancel・capture喪失・blur・非表示・閉じる際にポインター状態を解放する。 | キーで100→125%、合成タッチのピンチで425%へ変化。ボタン・移動・中ボタン解除・キャンセル・再表示をブラウザーテスト。 |
| 17 | Escapeで親の設定メニューまで閉じる | 言語候補で処理したEscapeの伝播を止め、親の設定メニューを維持する。 | Escapeで候補だけが閉じ、設定は開いたまま。フォーカスは言語選択入力に残る。 |
| 18 | DnDで子ページをルートへ戻せない | 前後・子階層・ルートへのドロップ先を修正。サイト見出し・末尾の追加行・ツリーの空き領域からルートへ戻せる。ドラッグ中のナビ再描画を保留し、開始時のワークスペースを保存完了まで保持する。 | 実際のドラッグで前後・子階層・3種類のルート復帰を確認。子孫への循環移動を拒否し、再読み込み後も順序を維持。blur時はマーカーと展開待ちを解放。 |

## 性能比較

| 条件 | 修正前 | 修正後 |
| --- | --- | --- |
| ナビ取得：本文2,000段落変更直後 | 約447ms | 0.555ms |
| ナビ取得：本文10,000段落変更直後 | 約1,808ms | 0.609ms |
| Git取得を250ms保留した間のナビ取得 | 約258ms・Git完了待ち | 0.722ms・Gitより先に完了 |
| 400項目・サイドバー開閉の最大フレーム間隔 | 50.1ms | 16.8ms |
| 1,000項目・サイドバー開閉の最大フレーム間隔 | 116.7ms | 33.4ms |

同じ実行環境で他のブラウザーテストから分けた単回計測。ナビは各計測内でYAMLを固定し、別文書の本文だけ変更。修正後の応答は各条件とも8,757 bytes（修正前8,176 bytes、並行作業の項目追加を含む）。1,000項目の開閉ではクリック処理23.9ms、32ms超のフレーム5回が残る。全環境の60fpsを保証する結果ではない。

## テスト結果

- **ビルド** — 成功。DnDのキャンセル処理を含む最終ビルドで確認。
  実行: `pnpm run build`
- **型検査** — 成功。
  実行: `pnpm exec tsc --noEmit`
- **単体・統合テスト** — 全体実行は1,638件中1,631件が成功。失敗7件はfetchのSignal期待値2件と文書リンク登録5件を修正し、対象7ファイル71件の再実行がすべて成功。未解決の失敗はなし。
  実行: `pnpm exec vitest run`
- **ブラウザー全体** — Chromiumで55件すべて成功。境界のないiframe埋め込み・通常のサイドバー操作も含む。
  実行: `node --import tsx --test scripts/test/browser.mjs`
- **最後のDnD確認** — 最新のキャンセル処理と展開待ち解除を含む対象テストが成功。
  実行: `node --import tsx --test --test-name-pattern='Navigation preserves the latest' scripts/test/browser.mjs`
- **変更ファイルの静的検査** — 今回の変更対象で成功。作業ツリー全体の無関係なファイルは一括整形していない。
  実行: `pnpm exec biome check <changed files>`
- **元の再現手順** — 性能計測を除く17シナリオがエラーなしで完了。性能は他のテストから分けて計測。
  実行: `/tmp/dooc-ux-verify.mjs`

全体実行で失敗したテストを直し、対象を再実行した。全単体テストを最初から再実行した結果とは区別している。

## 実装・検証の対応ファイル

- **#01 ペイン切り替え中のクリックが捨てられる**: [packages/frontend/src/edit-client.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/edit-client.ts), [scripts/test/ux-navigation.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-navigation.mjs)
- **#02 ナビの取得が本文解析を待っている**: [packages/frontend/src/document-application.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/document-application.ts), [packages/server/src/workspace-ux.test.ts](/home/a/repo/dooc-dev/dooc/packages/server/src/workspace-ux.test.ts)
- **#03 Gitの待ち時間がナビにも波及する**: [packages/server/src/workspace-server.ts](/home/a/repo/dooc-dev/dooc/packages/server/src/workspace-server.ts), [packages/workspace/src/client.ts](/home/a/repo/dooc-dev/dooc/packages/workspace/src/client.ts), [packages/workspace/src/server.ts](/home/a/repo/dooc-dev/dooc/packages/workspace/src/server.ts), [packages/workspace/src/application-transport.test.ts](/home/a/repo/dooc-dev/dooc/packages/workspace/src/application-transport.test.ts)
  Browserワークスペースでは、共有するファイルシステムの保存単位を守るため既存のロックを維持。実行済みの書き込みは中止で巻き戻さない。
- **#04 応答が逆転すると本文が古くなる**: [packages/frontend/src/edit-client.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/edit-client.ts), [packages/frontend/src/edit-races.test.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/edit-races.test.ts), [scripts/test/ux-navigation.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-navigation.mjs)
  応答逆転を注入した耐性確認。元の監査でも通常接続での自然発生や永続データの消失は確認していない。
- **#05 「戻る」を重ねると途中で止まる**: [packages/frontend/src/edit-client.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/edit-client.ts), [scripts/test/ux-navigation.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-navigation.mjs)
- **#06 言語変更で2つ目のファイル一覧が消える**: [packages/frontend/src/files-ui.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/files-ui.ts), [scripts/test/ux-state.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-state.mjs)
- **#07 移動中の選択表示が元へ戻る**: [packages/frontend/src/edit-client.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/edit-client.ts), [packages/frontend/src/nav-update.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/nav-update.ts), [scripts/test/ux-navigation.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-navigation.mjs)
- **#08 応答が逆転するとツリーの名称が戻る**: [packages/frontend/src/edit-client.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/edit-client.ts), [scripts/test/ux-navigation.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-navigation.mjs)
  応答逆転を注入した耐性確認。通常接続での自然発生を示す結果ではない。
- **#09 項目が多いとsidebarの開閉が重い**: [packages/frontend/src/document-application.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/document-application.ts), [scripts/test/sidebar-collapse.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/sidebar-collapse.mjs)
  1,000項目では33.4msのフレームが残る。全環境での60fpsは保証しない。数値は同じChromium環境での単回計測。
- **#10 見た目と読み上げ向けの現在位置がずれる**: [packages/frontend/src/edit-client.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/edit-client.ts), [scripts/test/ux-navigation.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-navigation.mjs)
- **#11 フォルダーの開閉でフォーカスが消える**: [packages/frontend/src/files-ui.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/files-ui.ts), [scripts/test/ux-state.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-state.mjs)
- **#12 本文リンクからの移動で操作位置を失う**: [packages/frontend/src/client-entry.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/client-entry.ts)
- **#13 Git画面が外部の変更を反映しない**: [packages/frontend/src/git-ui.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/git-ui.ts), [scripts/test/ux-state.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-state.mjs)
- **#14 開いたままの検索結果が古くなる**: [packages/frontend/src/search.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/search.ts), [packages/frontend/src/hmr-client.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/hmr-client.ts), [scripts/test/ux-state.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-state.mjs)
- **#15 Filesを経由するとダーク設定が変わる**: [packages/frontend/src/theme-picker.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/theme-picker.ts), [scripts/test/ux-state.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-state.mjs)
- **#16 拡大図をタッチ・キーで操作できない**: [packages/frontend/src/resource-download.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/resource-download.ts), [scripts/test/resource-download.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/resource-download.mjs)
  タッチはChromiumの合成イベントで確認。物理マウス固有のオートスクロールや実機タッチは未確認。
- **#17 Escapeで親の設定メニューまで閉じる**: [packages/frontend/src/language-picker.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/language-picker.ts)
- **#18 DnDで子ページをルートへ戻せない**: [packages/frontend/src/document-application.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/document-application.ts), [packages/frontend/src/edit-client.ts](/home/a/repo/dooc-dev/dooc/packages/frontend/src/edit-client.ts), [scripts/test/ux-navigation.mjs](/home/a/repo/dooc-dev/dooc/scripts/test/ux-navigation.mjs)

## 確認範囲と残る制約

- Chromiumによる自動確認が中心。Firefox・Safari、実機のタッチ操作、物理マウス固有の中ボタン動作は未確認。
- 1,000項目の開閉には最大33.4msのフレームが残る。メインスレッド自体を長く占有する処理まで、この変更ですべて非同期化したわけではない。
- Browserワークスペースのファイルシステムロックは維持。Nodeの読み取り分離と同じ並列性をBrowserの全操作に導入していない。
- 外部URLは中央領域いっぱいのiframe表示を維持。外部サイトが埋め込みを拒否する場合は、そのサイトの制約に従い外部表示へ案内する。
- 今回の17指摘と追加DnDの操作経路を確認したレポート。未発見の不具合がないこと、WCAG全項目への適合、全画面のデザイン品質を認証するものではない。
- パッケージ公開・実機インストールの再試験は今回の範囲外。README.mdは編集していない。

設計は[ux-sidebar.md](dooc-docs/contents/md/ux-sidebar.md)に記録。元の監査ファイルは保存し、今回の結果は別ファイルとして発行した。元の参考スコア9 / 20は修正前のものであり、今回新しい点数は付けていない。
