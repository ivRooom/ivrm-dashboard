# Telemetry送信待ちキュー（本番未導入）

関連: #135 / #142、受信側PR #147、ivrm-contracts PR #18。

## 範囲

`apps/telemetry-sender` は正規化済みbatchを永続キューへ入れて送る共通部品。追加の `capture-once` は固定パスの投影済みJSONLを読み、checkpointとbatchを同じtransactionで保存する。Docker、systemd、OS認証、proxy、Vercel、Cloudflareのネイティブ形式アダプター、timer、配布artifactは未実装。これだけで全システムの収集は始まらない。

受信側と同じrevision固定Schemaでenqueue時に検証する。SQLiteで原文byte列とbatch IDを固定してcommit後にqueuedを返す。送信時は毎回nonce/時刻/HMACを作り直す。200/202のSchema・batch ID・件数・replayedを検証したときだけ本文を解放し、重複比較用hashを保持する。応答不明や接続切断では同じ本文を再送する。これはat-least-once送信と受信側の冪等性の組み合わせであり、ネットワーク上のexactly-onceを保証するものではない。

同じDBを利用するプロセスはSQLite transactionと30秒leaseで送信権を取得する。leaseを取り直した後の古いworkerは結果を書き込めない。既定20試行、7日超過、恒久拒否でblockedへ移し、本文を保管する。408/429/503はRetry-Afterと指数backoff＋jitterを適用する。404は未有効化として再試行する。blockedの自動再開・削除は行わない。

## 使用条件

開発用Node 22.23.0で検証。`node:sqlite` はこのruntimeでExperimentalWarningが出るため、実ホスト向け配布の前にruntime固定・互換性検証が必要。Webアプリの起動から自動実行されない。現在は同repoのWeb契約validatorと開発用tsxを参照する準備段階。

以下はrepo rootからのローカル検証用。パスは絶対パスに置き換える。

```text
pnpm --filter @ivrm/web exec tsx ../telemetry-sender/cli.ts enqueue ABSOLUTE_PRIVATE_DIRECTORY PRODUCER_ID ABSOLUTE_BATCH_JSON
pnpm --filter @ivrm/web exec tsx ../telemetry-sender/cli.ts status ABSOLUTE_PRIVATE_DIRECTORY PRODUCER_ID
```

`send-once` の署名鍵は環境変数 `IVRM_TELEMETRY_PRODUCER_SECRET` から読む。引数やDBへ保存しない。送信先は `https://console.ivrm.jp/api/agent/telemetry` 固定、リダイレクト禁止、8秒timeout。契約pinがcandidateの間、公開送信関数は通信を始めず拒否する。テストだけは注入transportを利用し、本番HTTPへ接続しない。merged pinへの更新だけで運用開始してよいという意味ではなく、設置・Secret・起動は別途承認対象。

エラー出力は固定文字列のみ。statusはstateごとの件数・byte数・最古イベント時刻を返し、本文や送信元個人情報を出さない。blocked件数やoldestの監視・通知接続は次工程で、現時点ではdashboardに自動表示されない。

### 既存キューの診断

`pnpm --filter @ivrm/web exec tsx ../telemetry-sender/cli.ts health ABSOLUTE_PRIVATE_DIRECTORY PRODUCER_ID`

既存DBだけをread-only transactionで読む。DBがなければ作成せず固定エラー・exit 1。本文・source名・producer名・credentialは出力せず、pending/blocked/delivered件数、payload使用量と上限、最古の未送信イベントの経過時間をJSONで返す。読取中に送信・claim・再試行・削除・migrationは行わない。

blockedが1件以上、未送信イベントが5分以上古い、batch台帳または本文容量が80%以上なら`attention`・exit 2。それ以外は`queue_clear`・exit 0。送信完了行も重複台帳の上限を使うため件数監視に含む。経過時間はeventのobservedAtからで、enqueue時刻や厳密な送信遅延ではない。

`queue_clear`は収集元/送信経路全体の正常判定ではない。収集停止で何もenqueueされない場合もあり、`captureFreshness: unknown`を保持する。filesystem空き容量やSQLite/journal使用量も未計測。通知・timer・Consoleへの接続、閾値の環境別採否は未実装。Windows ACLは本番対応していない。診断だけで本番配備/契約candidateの送信禁止を解除しない。

### 収集処理の確認時刻

`capture-once`/`drain-once`はcheckpoint登録済みsourceの確認結果をローカル`capture_checks`へ最大64source保存する。idleでも読取検証が成功すればchecked、読取失敗はfailed。初回checkpoint前の失敗は新規登録せずmissingとして検出する。古い時刻の処理結果は新しい記録を上書きしない。drainの`rotation_already_completed`は現在fileの読取検証を行わないため鮮度更新に使わない。

```text
pnpm --filter @ivrm/web exec tsx ../telemetry-sender/cli.ts health-sources ABSOLUTE_PRIVATE_DIRECTORY PRODUCER_ID ABSOLUTE_EXPECTED_JSON
```

期待リストは8KiB以下の `{"expectedSourceIds":["example-source"]}`。1〜64の重複しない固定IDを指定する。診断は期待リストを自動検出せず、未稼働対象を勝手に除外しない。sourceの名前・path・エラー本文はJSONへ出さず、recent/stale/failed/missingの集計だけ返す。未確認/failed/確認から120秒以上はattention・exit 2。通常のhealthコマンドは期待リストがないためcaptureFreshness unknownのまま。

これは**collectorによるfile確認の鮮度**であり、上流アプリ/ログexporterの稼働・末尾partial行の進捗・全イベントの配送完了を保証しない。`upstreamHealth: unknown`を維持する。120秒は準備段階の固定値で、本番timer間隔/休止対象との調整は未実施。各timerの導入・通知/Console接続は別工程。

sender初期化は既存queueを保持したままlocal SQLiteへ追加tableを作る。health自身は旧DBへtableを作らず、記録がなければmissingを返す。診断記録はcheckpoint/batch transactionの後に書くため、記録失敗でcaptureがerrorになってもcheckpointが既に進んでいる場合がある。再実行はcheckpointから継続し、診断失敗をqueue未保存や安全な消去と解釈しない。rollbackは旧senderへ戻してqueueと追加tableを保持する。共有DB migration/本番適用は今回行っていない。

## 保全・容量・セキュリティ

- 送信前の本文をローカル保存する。送信元アダプターは**enqueue前に秘密情報を除外・マスキング**する必要がある。受信側のマスキングだけでローカル原文が消えることはない。鍵は本文に含めない。
- 専用ユーザーのローカルディスクを使う。最終directoryはPOSIX 0700、DBは0600。最終directory/DBのsymlink、DBのhardlinkを拒否する。親directoryは信頼された管理下に置く。Windows ACLの安全性はこの実装では検証しないため、本番Windows配備は未対応。
- SQLite DELETE journal / synchronous FULL。既定上限は送信完了・blockedを含む10,000batchと未解放本文64MiB。複数プロセスで上限を変えられないよう設定をDBへ固定する。設定変更はqueueを保持したmigrationが必要。
- DBは32,768page上限（新規4KiB pageなら128MiB）。journal・一時ファイル・filesystem overheadは別なので専用ディスクquotaと空き容量監視も必要。SQLiteは暗号化されない。ディスク暗号化とbackupの保持制御を運用で用意する。
- 上限では新規enqueueを拒否し、既存証跡を自動で追い出さない。呼び出し元はqueued確認前に読み取りcheckpointを進めない。失敗を捨てずに通知するアダプター実装が必要。
- 成功した本文の領域はSQLiteの空きpageに残り得る。NULL化は安全な消去を意味しない。重複台帳やblockedの保持期間・明示的整理・暗号化鍵の扱いは別工程で決める。

## 検証と導入順

`pnpm --filter @ivrm/web exec tsc --project ../telemetry-sender/tsconfig.json` と `pnpm --filter @ivrm/web exec tsx --test ../../tests/telemetry-spool.test.mjs` をCIで実行。

Producerは将来の各環境アダプター、consumerはdashboard受信API、Contractはoperational-telemetry.v1 candidate。PR #147をbaseとするstacked PRで、contracts→受信側のmerged pin更新/PR147→本PRの順にmergeする。既存Minecraft senderを置き換えない。

本番導入前に、アダプターのrotation/checkpoint、送信量・ディスク/DB/通信費、S3保全、blocked通知、保持期間、Linuxでのプロセスkill/ディスク満杯試験を追加する。対象を限定した承認後に1送信元から開始する。Rollbackはアダプター/送信timer停止、queue保全、受信側flag無効化。SQLite削除・証跡削除は行わない。本PRで本番配置・起動・Secret・課金変更は行っていない。

### 保存先filesystemの空き容量

health/health-sourcesはqueue directoryのstatfsをread-onlyで取得する。呼出しユーザーが使えるbavailを使い、64MiB未満または全体の5%未満ならfilesystem_capacityを返す。固定inode上限が報告されるfilesystemでは残り5%未満でfilesystem_inodes。inode上限0はnot-reportedであり無制限を保証しない。返すのはbyte数と取得状態のみでmount/pathを含めない。filesystemFreeSpaceはmeasured、詳細はfilesystemへ追加する。

statfs失敗・不正値は固定エラー/exit 1で正常へ代替しない。閾値は暫定の運用診断値でSLOではない。quota、他プロセスによる急増、SQLite journal最大容量、暗号化、I/O成功を保証しない。ネットワークmountではstatfsの所要時間をNode内で制限できないため、配備対象は既存方針のローカルディスクとし、timer接続時は外側のtimeoutも設計する。自動削除・vacuum・quota/ディスク拡張は行わない。本番Windows ACL未対応を維持する。
