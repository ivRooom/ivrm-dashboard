# Backup Age pause 実装・適用記録

更新: 2026-10-25 / Issue [#138](https://github.com/ivRooom/ivrm-dashboard/issues/138), [#117](https://github.com/ivRooom/ivrm-dashboard/issues/117)

PR: [#158](https://github.com/ivRooom/ivrm-dashboard/pull/158)。CIの最新head結果はPRのChecksを参照する。merge/deployは独立gate。

## 本番適用完了 — 2026-10-25

ユーザーが既存DBへのmigration・Web・5対象のAge停止を明示承認し、継続実行を指示。PR158はhead `a2e40ba`の全Checks成功、mergeable/CLEAN、未解決thread0、独立review完了を再確認してmerge。実施記録:

- Supabase `ivrm-core`へ承認済みSQLを適用。実履歴version `20261025015453` / name `backup_policy_lifecycle`。初期source filename `20261024100017`を実履歴に合わせてrenameし、将来のdb pushで同じDDLを再実行しないよう整合。SQL本文は同一、production historyの手修正なし。
- v2 rows6、v1の旧field値は完全一致、初期pause0、anon/authenticated execute拒否・service_role execute許可・service_role table UPDATE拒否を検証。
- main merge `6949f605d2236bdcaf635718a290feca67084385`、CI run `40152465463` success。Vercel `dpl_3oZob1ui2XBiAMrjzGcmY6bjykAe` production READY、commit一致、`console.ivrm.jp` alias確認。
- prepare SQLを承認済み値へbindし、MCP用にpsql meta-commandだけを除いてtransaction実行。Paper/Skyblock/Hardcore/GTNH/ATM10の5tupleだけを`2026-11-01T06:00:00Z`（11/1 15:00 JST）まで設定。理由は`dashboard#138: stopped targets pending final archive review`。
- 全6policy enabled=true、Warning24h/Critical48h維持。5対象のAge helperだけ`backup_age_paused`、mainのAgeと全対象のRetention/Restore helperはnull（非抑制）を確認。通知を新規送信するテスト/手動dispatcher起動はしていない。
- 未認証`/backups`は307 login、`/api/logs`401、private/no-storeを維持。`/login`200。既存browser接続はtimeoutのため認証済み実画面の目視受入は未実施。DB read modelと配備commitの照合を受入証跡とし、ブラウザー確認済みと偽装しない。
- OCI read-onlyでmain healthy、10/25 03時backup exit0を確認。host/timer/producer/保存世代/削除/IAM/Secret/新resource変更なし。

初回productionのrollback先は`dpl_pTjWqibMeufqCTJkoQyZ9TYUgBL2`（旧main b35ad5f）。Age再開は既存resume SQLへ上記と同一のuntil/reasonを渡す。追加列は残す。下の「未実行」記録は実装時点の履歴であり、この適用記録で更新する。

## 実装範囲

- branch `codex/backup-policy-lifecycle`、base main `b35ad5f3cd1fab9323a60d87cbd13d5730c8a2f8`。
- migrationはpause列・上限検証trigger・v2 read RPC・Ageだけのdynamic suppression。migration自体でpolicy値は変わらない。
- Backup Centerはpause期限/理由と実Ageを表示し、Ageだけの判定を止める。他の異常/証拠欠損は保持。統合incidentのAge依存も同じ条件へ整合。
- [仕様](backup-age-pause-spec.md)、[運用](runbooks/minecraft-backup-operations.md)、[復元](runbooks/minecraft-backup-restore.md)、guard付きoperator SQLを追加。

## 検証

ローカル13件のbackup health/境界/RPCエラー試験と型チェック成功。使い捨てPostgreSQL17（tmpfs、task label付き）で実migration・既存実装のclaim/delivery gateを使い、pair/30日制限、exact signal/policy、historical event、queued/claimed、自然な期限切れ、sent履歴、v1/ACLを検証して成功。外部通知なし。CIにも同じ試験を接続。

Build成功、全39件のNodeテスト成功。独立read-only reviewの対象競合・理由文字数/Unicode差異を修正し、focused13件/型チェック/実PostgreSQLを再検証成功。絵文字・タブ・Unicode空白・過大paddingを含むDB/Webの制約整合も検証し、最終独立reviewの追加指摘なし。実operator prepare/resumeも5対象だけへの適用とmain除外、enabled維持を検証した。本番migration/metadata設定/新Web配備は未実行。実backupのchecksum全読取/取り出し/復元試験は未実施。現実のarchiveを検証したという意味ではない。

## 導入順と承認対象

1. PR/CI/reviewとmigrationの差分を確定。productionはmain mergeによるVercel Git deployの可能性も含め確認する。
2. 既存DBへadditive migration→Web(v2)→認証済みページ受入。RPC失敗をhealthyにしない。
3. 停止・廃止予定5対象を再照合し、Ageだけを11/1 15:00 JSTまで停止するoperator SQLを承認後に適用。main/保管設定/producerは変更しない。

追加resource/plan/retention増加/restore requestはなし。今回差分にはバックアップ保存容量増加を伴う設定は含まれない。将来のDaily14世代等は現行単価・容量・request/取り出し/転送/compute見積と別費用承認が必要。

Rollbackは同じuntil/reasonでresume SQL。Webを旧versionへ戻してもDB列は残す。削除/保持短縮をrollbackに混ぜない。pause解除後もsent通知の再通知は保証しない。

## 次の3タスク

1. 認証済み画面の目視受入と、11/1の期限前に5対象の最終保管方針/継続停止/再開を確定。
2. 5対象+旧Fabric/既存decommissionedの最終保管台帳、version総量/lock、復旧依存の確認。
3. 別Infrastructure変更で世代・checksum証拠・隔離restoreの差分/費用/rollbackを準備。
