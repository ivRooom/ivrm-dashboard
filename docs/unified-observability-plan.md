# 全システム監視・セキュリティ・操作基盤の実装計画

作成: 2026-10-17。状態: 計画・Issue分割済み、実装と本番受入は未完了。

親Issue: [dashboard #142](https://github.com/ivRooom/ivrm-dashboard/issues/142)。契約Issue: [contracts #17](https://github.com/ivRooom/ivrm-contracts/issues/17)。本書の`#番号`は特記がない限りivrm-dashboardを指す。

## 目的と現状

ivRooomの全プロダクトについて、環境をまたいでサービス、ホスト、コンテナ、アクセス、認証、操作、バックアップを追跡する。対象環境はOCI、EC2、Lightsail、Vercel、Cloudflare等。Catalogだけで全件とせず、GitHubのactive repository、hosting、runtime inventoryとの照合によりAI等の未登録サービスも検出する。外部の管理対象外コンテナを無制限に収集する意味ではない。

確認基準main: `37ff56af5e0a3cbf243c5093821a3834d89776af`。

- `/logs`は`oci-minecraft-01`固定、sourceはMinecraft系コンテナとAgentの固定リスト。5秒poll、表示最大800件、取得API最大500件。既存ログストリームを長期保管や全件exportと同一視しない。
- `/operations`は`mc-main`の固定lifecycle操作。サービス監視の拡張は#127で進んでいるが、全サービスの操作完了ではない。
- Discord session/RBAC、操作job/lease/audit、Notification Center、backup read model等を再利用する。
- `backups.ts`のCritical SLAは最新成功のcompletedAtからの経過と対象別閾値の比較。SHA-256 nullは未取得、falseは検証失敗。サービス復旧とは独立した条件。
- UUIDのみから主体の所属・侵害は判定できない。ユーザー提示UUIDの本人照合および現在の本番警告原因は未実査。
- open PR #130/#132は確認時mergeable、Web/Agent CI成功。未mergeであり本計画の前提として勝手に取り込まない。READMEの未実装logs等の古い記述より現行mainを優先する。

## 段階と追跡先

| 順序 | 実施内容 | 追跡先 | 受入の出口 |
| --- | --- | --- | --- |
| A | 対象台帳、アクセス経路・権限・課金・取得制約を棚卸し | #127 / #131 | 各sourceのowner・取得可否・未対応理由が揃う |
| B | MFA/passkey、重要操作step-up、主体表示、backup警告切り分け | #133 / #134 / #138、既存#54 / #117 | API否定テストと証跡に基づく診断。本番認証切替は別管理 |
| C | versioned telemetry契約、全source ingest、検索・コピー・出力 | #135、ivrm-contractsの専用Issue | rotation/retry/認可/秘密除去/欠落の試験が通る |
| D | AWS長期保管とsecurity相関 | #137 / #136 | 費用承認、hash付き保管、再取得と攻撃/遮断/成功の区別 |
| E | 全systemの履歴・負荷計測と固定操作拡張 | #139 / #127 | 周期の負荷実測、service別認可と復旧条件 |
| F | 通知rule管理、Navigation・Overview刷新 | #140 / #141 | mock配送/権限試験、desktop/mobileの導線受入 |

小さいPRごとに実装→テスト→CI→review→merge。merge、本番反映、本番受入を別々に記録する。全体設計の確定前にUIだけを全システム対応済みと表示しない。

## 収集と調査の構成

```text
host/container/systemd/app collectors    provider log/API adapters
             \                              /
       認証付きingest / versioned event / source registry
                   | 秘密除去・上限・重複排除
          短期検索store + timeline + metrics
                   | checkpoint / durable queue
          AWS archive (S3候補) + manifest/checksum
                   |
          権限付き再検索・export・復元検証
```

Telemetry共通候補: schemaVersion、eventId、observedAt/receivedAt、serviceId、provider、resourceId、host/container/source、level、eventType、request/trace correlation、actorのprovider/subject/role/type、認証強度、action/target/outcome、信頼できる入口で得たclient IPと取得根拠。security evidenceにはrule/version、根拠参照、確信度、欠落を持たせる。actorやIPが得られない場合はunknown。過去イベントへ推測値を補完しない。

Dockerだけでなく、proxy・OS認証・SSM・cloud control-plane・WAF・アプリ認証/権限・操作履歴も対象。Vercel/Cloudflareはplan、dataset、保持期間、出力手段、samplingによるcoverage差を台帳化する。取れない項目を正常やゼロとして描画しない。

client IPは任意のX-Forwarded-Forを信頼せず、実際のedge→origin経路と上書き規則を検証する。IPは接続元の手掛かりであり人物特定ではない。アクセス成功、認証成功、攻撃検知、遮断、変更成功を別イベントとして扱い、侵入成功を過剰断定しない。token、cookie、password、環境変数、秘密を含むraw payloadは保存しない。IPと主体データは用途、閲覧権限、保持、マスク、export監査を設計する。

## 安全な操作と認証

MFA必須化はブラウザ画面だけでなく全APIのserver-side認証強度検証を含む。Discordログインだけで2FA済みと扱わない。passkey登録・復旧・紛失対応、session失効、role変更、短命step-up、監査を設計し、既存#54と将来SSO方針を整合させる。

#127の操作対象をservice/resource/action registryへ拡張する。各host/containerには登録した固定actionのみ許可し、provider credentialやDocker socketをbrowserへ渡さない。actionごとにRBAC/step-up/CSRF、冪等性、排他lease、timeout、audit、backup/restore readiness、実行後health gate、kill switchを要求する。Web/DB/worker/proxy等の停止依存関係を個別に定義し、一括再起動や任意shellへ一般化しない。停止・再起動・restore実機試験はmaintenanceとrollback条件を別途確認する。

## 保管・費用・更新周期

S3をarchive第一候補とし、検索用は既存短期storeを起点に評価する。CloudWatch Logsは運用・検索の代替、S3/Athenaは長期検索の追加候補。Loki/OpenSearch等の常設基盤は実測上の必要性が出てから評価する。

暫定値（採用・稼働の承認ではない）: 短期検索7日、archive90日、5分または圧縮10MiBでbatch、host/container 15–30秒、cloud API 60–300秒、表示5–15秒。security監査の保持期間は用途別に別決定する。高優先security eventは別の低遅延経路を検討する。ログ収集と画面更新とcloud API周期を分離する。

収集済み件数、圧縮GB/day、archive lag、queue backlog/dropped、DB write、CPU/RAM/IO、帯域、API quota/429、同時viewer数、p95表示遅延を測る。非表示tab停止、shared cache、cursor差分、jitter/backoff、downsampleとcardinality上限を設ける。既存5秒pollを全sourceへ無条件展開しない。

月額はregion別保存GB-month、PUT/GET/LIST、retentionによる世代、転送/egress、provider drains、KMS、検索scan、実行基盤、既存Supabase/Vercel quota増加を合算する。単価・実使用量・契約plan未確定のため確定額/無料とは言わない。#137で対象リソース、実測と計算式、上限、停止・削除・既存証跡の扱いを含む承認資料を準備してから有料変更へ進む。

archive成功はmanifest件数/hash/checkpointで確認。再送は冪等、送信前に秘密除去、bounded disk spoolと満杯時policyを定義。archive失敗中のTTL削除・欠落も監視する。公開禁止・暗号化・write/read/delete権限分離。VersioningとObject Lockは保持・費用・削除制約を確認して別途決める。

参考（2026-10-17確認、account適用可否は未確認）:

- [AWS S3料金](https://aws.amazon.com/s3/pricing/): 保存以外にrequest・移行等も見積対象。
- [Vercel Drains](https://vercel.com/docs/drains): 利用料金とschemaを導入前に確認。
- [Cloudflare Logs FAQ](https://developers.cloudflare.com/logs/faq/general-faq/): coverage限界を確認。
- [OpenTelemetry resiliency](https://opentelemetry.io/docs/collector/resiliency/): queue/retry/persistent storage設計の参考。Collector採用は未決定。

## Repository境界と順序

Producer: dashboard agent/provider adapter、および各serviceのapp/auth/audit emitter。Consumer: dashboard ingest/query/security/archive。共通shape正本はivrm-contracts。契約名候補`operational-telemetry/v1`（未発行、未採番）。既存Minecraft ingest契約は互換維持する。

1. contractsで追加契約とfixtureをPR/CI/review/merge。
2. dashboardで新旧両対応consumerを先にmerge、承認された変更手順で反映。
3. 各producerを個別PRで追加し、schema/認証/冪等性のconformance検証後、段階導入。
4. 少数sourceで件数・遅延・秘密除去・archive再取得を確認後にcoverageを拡大。

Rollback point: source単位のingest/export/action feature gateを停止し旧経路へ戻す。既存archive/監査証跡は削除しない。認証強度を下げて回避しない。DB migrationはadditiveを基本とし旧consumerを壊すcleanupは別PR。本番DB/IAM/DNS/Secret/有料設定はapplication変更と分離。IaC管理資源は所有IaCから変更し、ivrm-platformからproduction deployしない。

## 次に実施する3タスク

1. #133/#134: 現行認証とaudit主体解決の設計、保証できるMFA手段・移行・復旧の確認、API否定テスト設計。
2. #138/#117: backup生成→同期→report→read modelのread-only照合で警告原因を特定。証跡がない値はunknownを維持。
3. #135/#137/#131: 全service/source coverage台帳、contracts PR、収集量と保存費用の計測設計を準備し、最小sourceから実装を開始。

今回: 計画文書とIssueのみ。runtime/DB/認証/クラウド設定変更、本番deploy、通知送信、負荷試験、有料機能有効化なし。
