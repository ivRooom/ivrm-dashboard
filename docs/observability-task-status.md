# 全システム監視タスク確認（2026-10-18）

動的状態の正本はGitHub Issue/PR/CI。以下はこの日の確認記録。すべて本番導入済みという意味ではない。

| 要望 / Issue | 確認した状態 | 次の作業 |
| --- | --- | --- |
| 全体計画 #142 | PR143 open | 依存順に実装・受入を管理 |
| 認証強化 #133 | パスキーまたはTOTP必須という方針。設計PR143、実装未完了 | 登録/復旧とserver-side MFA検証、非本番否定テスト |
| 操作者表示 #134 | ivrm-web PR501 open、CI成功 | レビュー・本番切替の準備。UUID/IPから外部/侵入者を推定しない |
| ログ #135 / セキュリティ #136 | コピー/出力PR145、source台帳PR146、受信PR147、送信PR148がopen | 固定ファイルcapture/checkpoint、環境別アダプターとactor/IPの信頼境界 |
| AWS保存 #137 | 本番アーカイブ未実装 | 保存量/保持/転送/復元を具体化し、費用提示後の承認で導入 |
| Backup #138 | 診断修正PR144 open。producerの検証証跡は未改善 | checksum/復元試験の証跡を生成。廃止予定5serverは削除せず保管方針整理 |
| Metrics #139 | 全system向け追加履歴は未完了 | source接続、負荷/保持上限、表示中のみ更新、欠測表示 |
| 通知 #140 | イベント別設定UI/配送拡張は未完了 | 設定/RBAC/配送状態/再送/監査 |
| 操作 #127 | 全system操作アダプターは未完了 | MFAとsource権限の後に固定actionを拡張 |
| UX #141 | 全体再設計は未完了 | 接続状況・欠測・操作権限を反映する情報構造 |

今回の順序はPR148のHTTP408指摘修正→capture/checkpoint→環境別収集/アーカイブ。PR148 `6bf128f` のWeb/Agent/semgrepは成功。該当指摘は解決済み。CodeRabbitはstacked baseを対象外としているためレビュー完了と扱わない。他の自動reviewが出した指摘は別途確認する。

PR147/148とcontracts18は未merge。candidate pinのまま本番送信を開始できない。Production deploy/DB/IAM/DNS/Secret/timer/flag/課金変更なし。準備PRをmergeして本番deployを起動する場合も対象別承認を分離する。
