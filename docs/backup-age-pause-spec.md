# Backup Age 一時停止仕様

作成: 2026-10-25 / owner: Dashboard / related: #138, #117

## 問題と適用範囲

停止中かつ既存archiveがあるサーバーをproducerがskipする一方、監視は全enabled policyへ24h Warning/48h Criticalを適用していた。GTNH/ATM10の10/24 15:00/15:01通知はこの条件に一致した。

最終保管を検証していない対象を恒久的に廃止済み扱いしない。今回実装するのは**期限付きのAge判定・Age通知だけの停止**。enabledを維持し、他の保護と履歴を残す。停止だけから自動判定せず、operatorが対象・理由・期限を指定する。保持世代の増加やバックアップジョブ変更はこの変更に含めない。

## Policyと権限

`backup_policies.age_paused_until` (timestamptz)、`age_pause_reason` (text)を追加。両方nullが通常状態。停止時は両方必須、理由はtrim後1〜256文字、変更時点より未来かつ30日以内。期限を過ぎた既存行は他の設定変更を妨げない。延長は再度未来/30日以内の検証を通す。解除は両方null。

管理用browser API/Agent write権限は追加しない。既存RLS/Force RLSとservice_roleのtable権限拒否を維持。認可済みDB operatorがchange controlのtransactionで設定し、変更前後と実行主体・承認参照を管理記録へ保存する。DB接続主体が共通roleの場合、それだけで個人監査を証明しない。

## 判定と配送

`until > current time`の間だけ停止。境界ちょうどでは通常判定。Webはsnapshot.generatedAt、DBは配送処理時のclock_timestampで評価。バックアップの実年齢はそのまま表示する。停止中でも成功Runがない場合はunknown、SHA false/失敗/期限切れはcritical、証拠欠損・復元期限切れ等は既存warningを維持する。

`notification_suppression_reason_v1`でhost+target+mode+typeから構成したentityと**完全一致のbackup_age signal**だけを`backup_age_paused`として抑制。通知の古いoccurredAtは停止期限の判断に使わない。既存のclaim処理と送信直前のdelivery gateが共通helperを呼ぶため、待機中とclaim済みの両方を対象とする。外部送信とDB検査は原子的ではなく、送信直前検査の後に始まったpauseで既送信を取り消せるとは保証しない。

Signalの事実・active状態は保持し、架空のrecovered通知を作らない。Notification Centerのactive signal件数は下がらないことがある。配送履歴にはsuppressed理由、Backup Centerには期限と理由を表示する。これは解決/復元可能の表示ではない。

期限後は既存dispatcherの規則に戻る。未送信で現在もactiveなepisodeの最新opened/escalatedは再配送可能。既にsentの通知はpause解除で再送されない。Age signalの本当のrecovery通知もpause中は抑制され、既存規則では期限後に単独再配送しない。定期リマインダー追加は未実装。

## 互換性と失敗時

既存`get_backup_center_v1()`は変更しない。新`get_backup_center_v2()`は既存行にpause metadataを結合したJSON配列を返すService Role専用read RPC。Webはv2を要求し、RPC失敗/不正metadataは取得エラーにする。取得不能をpaused/healthyへ倒さない。旧consumerはAgeを従来どおり表示するため、DB migration→新Web→operator pauseの順で導入する。

Agent report/HMAC/ingest契約は変更なし。Producer=既存OCI reporter、Consumer=Dashboard。RPCはDashboard内のversioned read modelであり、cross-service Event version追加なし。停止metadataをAgentから変更できない。

## 受入条件と範囲外

- max30日、理由/null pair、期限境界、他policy/他signal非抑制。
- queued/claimedのAge抑制、期限後の未送信episode再開、sent履歴不変。
- 他のfailure/証拠欠損/unknownとv1/ACLを維持。
- migrationだけでは対象policyを停止しない。resumeはmetadata解除だけで可能。

恒久retired state、最終保管の存在監視、remote checksum生成、restore実行、世代増加、削除権限分離は次段階。現在これらを実装/本番完了と扱わない。
