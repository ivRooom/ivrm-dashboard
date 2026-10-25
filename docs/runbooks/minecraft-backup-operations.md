# Minecraft バックアップ運用手順

作成: 2026-10-25 / 対象: OCI backup producer、S3、Console / #138

## 現行構成と日常確認

`mc-backup-s3.timer`はJST03:00/15:00。mainはworld save→save-off→archive→save-on→S3送信、reporter→監視DBという経路。停止+既存local archiveのtargetはskip。service successだけではreport到達、checksum、復元可能性を保証しない。

日次で次を照合する。承認済み既存管理経路を使用し、認証値やarchive本文を公開ログへ出さない。

1. `systemctl show mc-backup-s3.service -p Result -p ExecMainStatus -p ExecMainExitTimestamp`と`systemctl list-timers --all mc-backup-s3.timer`で実行と次回予定を確認。
2. `journalctl -u mc-backup-s3.service --since '24 hours ago' --no-pager`を管理端末内で確認。target別のcreated/skip/failure、save-off/on、upload、report HTTP結果を分ける。全文をIssueへ貼らない。
3. `/backups`で最新成功時刻、remote同期、最終受信、SHA/Retention/Restore証拠を確認。生成・S3・DBの同じartifactを照合。サイズ一致は完全性検証ではない。
4. 停止期限・理由を確認。期限後の継続保管/再開をownerへ確認し、無期限延長しない。backup_age以外のwarningを独立して調査する。

失敗時は既存の検証済みarchiveを残す。save-on失敗/整合性不明ならarchive成功を安全とみなさず、対象maintenanceと手動復旧をchange controlへ上げる。自動で再起動/restoreしない。

## 一時停止の適用

Migration `20261024100017_backup_policy_lifecycle.sql`と新Webを先に導入し、v2 RPC/認可/ページ受入を確認する。Migrationは保持設定やpause値を変更しない。

最初の候補は`oci-minecraft-01`のPaper/Skyblock/Hardcore/GTNH/ATM10、Ageだけを2026-11-01 15:00 JSTまで。mainは対象外。実施前に現時点でも停止/廃止予定であることを再照合し、対象/期限/戻し方を含む承認を確認する。適用SQLは[prepare](../../deploy/sql/backup-age-pause-prepare.sql)、[解除](../../deploy/sql/backup-age-pause-resume.sql)。prepareは**明示transaction**、対象5件・full・mode・enabledを照合し、相違ならrollback。実行例（接続先/credentialは承認済み秘密管理経路から渡す）:

```bash
psql "$APPROVED_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v pause_until='2026-11-01T06:00:00Z' \
  -v pause_reason='dashboard#138: stopped targets pending final archive review' \
  -f deploy/sql/backup-age-pause-prepare.sql
```

実行前後のpolicy ID/tuple、enabled、旧pause、期限・理由・時刻・承認・operatorを私有change記録へ保存する。SQLは変更前後を返すが、外部audit storageへの自動保存はしない。環境変数の値/接続文字列をechoしない。

適用後はmetadataと`/backups`表示、次のdispatcherによる`backup_age_paused`を確認する。外部Discordテスト送信は別途許可がある場合のみ。active signalは残り得る。解除/期限切れでsent通知の再送は保証しない（[仕様](../backup-age-pause-spec.md)）。実行失敗時に部分適用していないことを確認し、無条件再試行しない。

## 世代管理の現状と次段階

現行localとDaily currentは各target最新1件。Daily noncurrentは1日後削除。Weeklyは30日GLACIER/180日DEEP_ARCHIVE、Monthlyは30日DEEP_ARCHIVE、取得ruleに両者のExpirationなし。停止targetのlocal7日削除→baseline再作成は廃止保管管理の代用にしない。

候補: main Daily7日/約14世代、Weekly8週、Monthly12か月。Dailyの現行約0.982GB×追加13件=約12.76GB増、合計約13.75GB（十進GB）。実施前にregion単価、全version、PUT/GET/転送、cold取り出し、最低保持/早期削除、復元computeを見積もる。無料枠/ゼロ料金を仮定しない。この変更は未承認・未適用で、今回のpause修正には含まれない。

廃止予定5件、旧Fabric、既存decommissionedを台帳化し、最終archive識別子/version、SHA、構成、復元手順、owner、保持期限/無期限理由を確認。WorldだけでなくJava/loader/MOD/image/config/権限とSecretの独立復旧を確認する。S3 version/lockの権限不足はunknownと記録し、権限追加で迂回しない。保管実証前にenabled=falseへ変更しない。

## ロールバック

pauseはresume SQLで解除。再開するAgeアラートを事前に把握する。Webだけ戻す場合は旧v1表示へ戻り、pause中でもAge Critical表示が復活する。旧コードと列/RPCは互換なので、緊急時に列をdropしない。新Webのv2依存がある間にmigrationを破壊的に巻き戻さない。

保存期間短縮やarchive削除は別の破壊操作。設定を戻しても消えたbackupは復元されないため、保管・復元実証と独立した削除承認が必要。producer/ingest/認証/DB/保存設定をまとめて巻き戻さない。
