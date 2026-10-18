# 固定ファイルの投影済みログ収集（本番未導入）

Tracking: #135 / #136 / #142。受信PR #147、送信PR #148に依存する。

## 対象と使い方

アプリ/コンテナ/systemd用の**投影済みJSONL**を、管理者が設定した1つの絶対パスから読み取る。Docker socket、任意コマンド、SSH、journalctl、provider APIには接続しない。Docker json-fileのネイティブ形式やOS認証ログを直接読むアダプターではない。

```json
{"path":"/var/log/ivrm-projected/service.jsonl","source":{"sourceId":"fixture-app-log","serviceId":"fixture-app","type":"application","provider":"other","hostId":"fixture-host"}}
```

上記は設定形式の例で、本番sourceの登録ではない。設定ファイルと親directoryは管理者だけが変更できる場所へ置く。パスのglobや再帰走査は行わない。入力元のfinal symlink/hardlinkを拒否し、regular fileのみ扱う。親directoryは信頼された管理下に置く。

各行は厳密に次の3fieldのみ。発生時刻は元ログの時刻であり、収集時刻に置き換えない。

```json
{"observedAt":"2026-10-18T00:00:00Z","level":"info","message":"sanitized application event"}
```

levelは契約のdebug/info/warning/error/critical。収集側で秘密・IP・制御文字を既存redactorに通してからSQLiteへ書く。すべての機密値を検出する保証はないため、投影元でも秘密情報を除外する。本文は最大2048文字へ切り詰められる。actor/IPはこのアダプターでは取得せず、kind=log / outcome=observedとする。失敗ログだけで侵入成功と判断しない。

```text
pnpm --filter @ivrm/web exec tsx ../telemetry-sender/cli.ts capture-once ABSOLUTE_PRIVATE_DIRECTORY PRODUCER_ID ABSOLUTE_SOURCE_CONFIG_JSON
```

CLIはローカルキューへ保存するだけで通信しない。送信は別コマンドで、candidate契約の間は無効。出力はstate/eventsのみ、エラーは固定文字列と非0終了。stdout/stderrへ元ログ・パス・資格情報を出さない。

## 欠落を避ける境界

- 1回64KiBまで読み、最大5行をbatch化。1行8KiBまで。末尾の改行がない行は保留する。UTF-8不正、空行、不正JSON、余計なfield、期限切れ時刻、行上限超過はその回を停止し、checkpointを進めない。
- batchとcheckpointを同じSQLite transactionでcommitする。満杯やcheckpoint保存失敗では両方rollback。並行collectorは保存前のcursorをcompare-and-swapし、競合した側は次回読み直す。
- source IDと絶対パス/metadataのhashを固定し、metadataを同じsource IDで付け替えない。登録cursorは最大64sourceまで。
- device/inode/offsetと直前64byteのhashをcheckpointへ記録。入力元はappend-onlyの投影fileとする。収集済みprefixをcommit前に再確認する。
- rename rotation、copytruncate、直前prefixの書き換えを検出したら失敗させる。**自動rotation drainは未実装**。新fileの先頭へ勝手に移動しない。元fileとqueueを保全し、所有者が未読部分を確認する。悪意あるwriterによる全書換えや、監視間隔内に消えた未観測ログを復元できる保証はない。
- idleはそのfileに処理可能な完全行がないという意味であり、サービス正常・全system収集済みを意味しない。失敗/未受信のdashboard表示・通知は別工程。

## 検証・導入・Rollback

テストは `tests/telemetry-file-capture.test.mjs`。保存前mask、再起動、partial行、batch上限、Schema拒否、満杯時のcursor不変、checkpoint INSERT障害の全rollback、rotation/truncation/rewrite/metadata付替え拒否を確認する。Web CIに追加し、sender専用tscも実行する。

Producerは管理された投影元→本collector、Consumerはspool→dashboard、Contract operational-telemetry.v1 candidate。Merge順はcontracts18→merged pin/PR147→PR148→本変更。PR148をbaseとするstacked PRであり、前段merge後mainへretargetする。既存Minecraft収集は変更しない。

本番投影元、元ログ保持期間、CPU/ディスク/通信量、mask例外、rotation drain、通知、S3保管を確認後、設置・timer・Secret・新規費用は別途対象を限定した承認で導入する。本PRで本番read/write・設置・起動は実施しない。Rollbackはcollector/送信timer停止と元ログ・queue・cursor保全。SQLiteや元ログの削除は行わない。
