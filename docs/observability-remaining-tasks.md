# 全プロダクト監視・運用: 残タスク

2026-10-19 GitHub照合。親Issue #142。PR作成、CI成功、merge、本番deploy、受入は別段階として扱う。作成済みPR143〜151は確認時open。platform PR47〜51もopenでvalidate/semgrep成功。レビューskipは承認済みではない。

| 優先 | 残件 / Issue | 現在の準備 | 次の具体的成果物 |
| --- | --- | --- | --- |
| P0 | passkeyまたは認証アプリ2FA必須 #133/#54 | 方針のみ。Discord OAuth成功だけでMFA済みにしない | 登録/紛失/独立復旧とserver側認証強度・重要操作再認証を実装、直接API等の否定試験 |
| P0 | Secret管理 platform #44〜46/#26/#27/#38、#152 | 値なし台帳/入口/保護metadata/CI候補/pilot計画 | job→Environment→OIDC→role→配送先を照合。方式・費用比較、dummy rotation/失効/復旧実証。UIは値read/write/IAM/deploy権限なし |
| P1 | 全systemログ #135/#131 | PR145コピー/出力、146台帳、147受信、148永続キュー、149固定file、150rotation、151Docker export | 契約release・merged pin、Linux配布/runtime固定、Docker安全exporter、OS/proxy/managed platform adapter、1送信元の受入 |
| P1 | queue/未着の検出 #131/#135 | PR154 read-only health、続いて固定expected sourceの読取確認時刻/failed/missing/stale診断を準備 | upstream exporter heartbeat、partial行進捗、ディスク空き容量、通知/Console表示。空queueを収集正常としない |
| P1 | 侵入経路・攻撃相関 #136 | 受信schema/署名/個別ログの基盤 | OS認証/WAF/HTTP/操作監査の接続、信頼proxy経由IP根拠、時系列相関。IPやUUIDだけで人物・所属を断定しない |
| P1 | audit操作者表示 #134 | ivrm-web PR501で準備、未deploy | admin.ivrm.jp/systemで表示/権限/不明actorの受入。実名を公開Issueへ転記しない |
| P1 | AWS保管 #137、platform #29/#35 | 設計段階 | S3等の量/保持/暗号化/削除権限/改ざん検知/再取得/費用/rollbackを準備し承認後IaC適用 |
| P1 | backup警告 #138 | PR144で不足/古い証跡の診断 | 最新artifact checksumと復元証跡をproducerから確認。廃止予定5serverの保管/保持/復旧期限を整理、削除は未承認 |
| P1 | 全system操作 #127/#68/#117 | 既存固定操作/Minecraft受入関連 | service allowlist・RBAC・lease・監査・復旧条件を対象別に拡張。MFA/再認証の後に本番有効化 |
| P2 | 履歴/リアルタイム #139/#12 | 既存Minecraft/host履歴あり | system別最短間隔と容量/保持/負荷を見積。未着と正常を区別。全対象を既存30秒履歴へ無条件追加しない |
| P2 | 通知ごとの設定 #140 | Issue化済み | event別有効/宛先/抑制・再送・監査、Webhook値をbrowserへ返さない設定API/UI |
| P2 | Navigation/Overview #141 | Issue化済み | 全systemの異常/未接続/maintenanceを先頭に出す情報設計、responsive実装・受入 |

## 進め方

1. 既存PRを依存順でレビュー・merge可能性確認。追加変更だけでopen stackを伸ばし続けず、受信契約と基盤を確定する。CI成功だけで自動merge/deployしない。
2. health CLIの未着検知接続とMFAの実装を優先。権限/復旧設計の確認なしに管理サイトへ全Secretを集めない。
3. 本番接続は対象/費用/保持/rollback/停止条件を用意して個別承認後に1送信元から。Secret、DB、IAM、timer、host、課金変更は未実施。

platform #52〜54とdashboard #153のDB集約計画もopen。別タスクとして所有者/容量/移行条件の確定待ちで、このPRはDB接続先や保存先を変更しない。S3や時系列追加との容量依存を比較に含める。

Runtime Producer/ConsumerやAPI/Event契約は今回変更しない。healthはローカル運用CLIだけで外部公開しない。Telemetry contract candidateは本番送信不可のまま。base PR151、既存契約→受信→sender/capture/rotation/export→本PRの順。rollbackは新CLI利用停止/コードrevert、queue証跡を保全する。
