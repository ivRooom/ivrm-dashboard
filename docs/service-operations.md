# サービス単位の監視・操作

Tracking: [Issue #127](https://github.com/ivRooom/ivrm-dashboard/issues/127)。操作基盤の既存範囲は #68、Minecraftの復元・停止受け入れは #117 を参照する。

## サービスと実行基盤

`apps/web/lib/service-catalog.ts` がレビュー対象の対応表。DNSだけでコンテナ名を推測せず、実ホストのコンテナ一覧とCaddyルーティングを照合する。

| サービス | 実行基盤 | 主なコンテナ |
| --- | --- | --- |
| mc.ivrm.jp | OCI / oci-minecraft-01 | mc-main, ivrm-velocity |
| member.ivrm.jp | EC2 / aws-app-01 | ivrm-member, ivrm-api |
| admin.ivrm.jp | EC2 / aws-app-01 | ivrm-admin, ivrm-api |
| herta.ivrm.jp | Lightsail / lightsail-herta（Agent接続予定ID） | herta-api-1, herta-studio-1, herta-worker-1, herta-bot-1 |
| ivrm.jp | EC2 / aws-app-01 | ivrm-home |
| api.ivrm.jp | EC2 / aws-app-01 | ivrm-api |
| console.ivrm.jp | Vercel | マネージド |
| ivmz.ivrm.jp | Netlify | マネージド |

EC2の共通依存はTunnelとCaddy。HertaはPostgres・Redis・Caddy・nginxも対象。完了済みmigratorや停止予定のmc-resourceを稼働必須に含めない。未分類のコンテナは削除・再起動せず、所有関係を別途確認する。

`/services` は既存のサーバー側監視データを統合する。取得失敗、未登録、未受信、無効な監視から正常を作らない。一つでも異常があれば要確認、必須情報が欠ける場合は監視未完了。Minecraftは既存のTCP・Backend Probeを利用する。EC2/Lightsailのコンテナ収集や追加HTTP監視が未導入の間、その項目を未受信として表示する。

## 追加収集の容量設計

追加の18コンテナを既存の30秒間隔・7日保持へ無条件に加えない。2026-10-15の参照結果ではDB約353MB、container_samples約94MB/16.5万行。1行あたりのテーブル・インデックス使用量を約569Bとすると、追加18対象×2,880回/日×7日＝362,880行、約206MB増となり、現契約のDB枠を超える見込み。

次の変更では最新状態をhost/container単位の固定行へupsertし、追加対象の履歴は5分間隔・7日保持へ分離する案を検証する。履歴36,288行は概算約21MBだが、実スキーマ・インデックス・VACUUM・既存集計・egressの余裕も確認する。既存OCI履歴を削除して空きを作らない。既存収集の鮮度や通知を壊さない。

この画面変更では追加Timer、Agent、認証情報、監視対象、DBスキーマを本番へ作成しない。追加費用0円を確認できない本番変更は保留する。

## 操作拡張の境界

既存のMinecraft操作はDiscord認証・RBAC・Origin/Host検証・Idempotency・Lease・排他・監査・実行側Gateを持つ。サービスのリンク追加を実行可能な操作の追加と扱わない。

次の実装で必要な契約:

- サーバー側のservice/host/container対応表から対象を決める。ブラウザ入力をShellやDockerの引数へ直接流さない。
- 参照診断は状態、リソース、制限されたredact済みログを構造化して返す。環境変数やフルinspectを返さない。
- 変更操作は対象・影響範囲・要求者・確認・費用承認・期限・結果を監査する。権限や期限が変われば再判定する。
- 共通依存（API/Tunnel/DB等）を再起動する場合、影響するサービスを提示する。
- サーバー起動やサイズ・構成変更は料金発生の可能性を判定し、事前承認なしで実行しない。承認できた具体的リソースと条件だけに適用する。
- 停止/再起動はバックアップと復旧方法を確認する。本番の停止を動作確認目的で自動実行しない。
- 任意Shellを必要とする場合は、既存の固定操作キューと分離した権限・短期セッション・出力制限・秘密情報の扱いを設計する。現状は未実装。

現在のこの変更は表示の第一段階。EC2/Lightsailのコンテナ収集と汎用のサーバー操作は未接続であり、Issue #127を完了扱いにしない。

## 検証とロールバック

`node --experimental-strip-types --test tests/service-catalog.test.mjs`、`pnpm typecheck`、`pnpm build`。ローカルでデータ取得不可時に8サービスが未確認となる表示を確認した。390px viewportで8カードを確認し、documentの横方向overflowなし（clientWidth/scrollWidthとも375px）。正常データのUI受け入れ検証は別途必要。

表示変更はPRをrevertしてロールバックできる。新しいDBや常駐処理を作成しないためデータ移行はない。
