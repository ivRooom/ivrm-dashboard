---
name: dashboard-operations-safety
description: ivrm-dashboardからMinecraftやホストの停止・再起動・復旧などの運用操作を追加/検証する。RBAC、対象固定、監査、重複実行防止、MCP権限、rollbackを強制する。
---

# Dashboard Operations Safety

## 実装境界

- `docs/service-operations.md`、`docs/operation-job-audit-foundation.md`、`docs/mc-main-safe-lifecycle.md` と実装を最新化。
- [infrastructure-change](https://github.com/ivRooom/ivrm-platform/blob/main/.agents/skills/infrastructure-change/SKILL.md) / [incident-response](https://github.com/ivRooom/ivrm-platform/blob/main/.agents/skills/incident-response/SKILL.md) / [MCP接続基準](https://github.com/ivRooom/ivrm-platform/blob/main/.agents/skills/tool-access-and-mcp/SKILL.md) を併用。

## オペレーション設計 / Review

1. サービス/host/containerのownerと、期待状態・共通依存（Tunnel、Caddy、DB、APIなど）を特定し、依存サービスの停止波及を見積もる。
2. UI入力をそのままShell/Docker/RCONへ渡さない。固定allowlistの操作だけをserver-sideで解決し、任意コマンド実行をデフォルト拒否。
3. Discord OAuth/RBAC、CSRF/Origin/Host、idempotency、期限付きLease、排他・retry、操作対象スコープ、監査ログを設計・テスト。
4. 再起動/停止/復旧/バックアップ/課金発生の可能性は機能名だけで安全と判断しない。Operatorと対応先ごとにapproval・monitoring・recovery pointを明示。
5. Docker Socketを非特権Go Agentへ渡さず、root Collectorと送信Agentを分離。収集はallowlistedの構造化・秘匿済みデータだけに制限。
6. Provider MCP/Pluginのツールアクセスはread-onlyを最初に検証し、write操作の権限が技術的に存在しても承認前に実行しない。
7. テストは拒否ケース（permission/nonce/replay/期限切れ）、同時実行、競合、部分障害、rollback、stale/incomplete statusを含める。
8. Live operationは明示承認前には行わない。コードが実装済みでもRemote操作を有効化したと断定しない。

## 完了ゲート

GitHub PR/CI/review、実行前のBackup/Restore、成功条件、Rollback、操作監査、通知の妥当性を示す。実運用の成功とローカルテスト成功を分ける。
