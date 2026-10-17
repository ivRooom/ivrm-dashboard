# 全システムログ収集元台帳

Issue #135/#131、親 #142、契約 ivRooom/ivrm-contracts#17 / PR #18。
`catalog/telemetry-sources.json`は計画用の台帳であり、runtime認可registryでも収集設定でもない。編集してもログ収集や課金機能は有効にならない。

## Coverageの読み方

2026-10-17のGitHub組織repository一覧（15件、うちarchive 2件）と現行service catalogおよびruntime container allowlistを照合。36収集元候補を記録した。host/container依存は物理sourceごとにまとめ、複数serviceとの関係を保持して重複収集を避ける。ownerRepositoryは現在の運用・設定の追跡先であり、アプリデータや全resourceのownership移管を意味しない。

| 状態 | 意味 | 正常と判断できるか |
| --- | --- | --- |
| legacy_configured | 現行mainの固定allowlistに存在。停止/未作成のsourceも含む | 受信・鮮度・欠落を別途確認するまで不可 |
| planned | topologyから特定したがログingestは未接続 | 不可 |
| needs_discovery | providerのplan/dataset/取得手段等が未確認 | 不可 |

OCI/EC2/Lightsailの全catalog container・共通依存、OS認証/journal、Vercel runtime、Cloudflare edge、AWS/OCI control-plane、Supabase監査、既存Netlify面を対象にする。ivmzは既存service catalogの観測面として記載するが、repository/組織ownershipを推測しない。

AI、help、member-site、status UI等は実際のhostingとproducer対応が未確定。mcmodのactivity eventをoperational log収集済みとみなさない。archived mail workerの後継と残存runtimeも未確認。GitHub activeであっても本番稼働とは限らない。metadata/IaC repositoryにproduction runtimeがあると仮定しない。

## 次の実装

1. Contract PR #18をreview/CI後にmergeし、consumerでimmutable bundleをpin。台帳からsourceを自動許可せず、producer credentialとserver-side source registryを個別に登録する。
2. sourceごとのcanonical serviceId、共有依存、owner、認証、取得権限、plan、retention、周期、stale/欠落、PIIを確定。client IPを送れるsourceをtrusted ingress adapterへ限定する。
3. 少数sourceでread-only collector→認証ingest→検索→archive再取得を検証。quota/負荷/費用を測定してから拡大する。

CIはruntime container allowlistとservice catalogのcontainer/依存/legacy allowlistが台帳から漏れる変更を拒否する。GitHub全repoや実hostを毎回照会するテストではないため、inventoryDateとGitHub/hosting/runtimeを定期的に再照合する。source数は監視完了率ではない。

## Backup廃止予定対象の別管理

Paper/Skyblock/Hardcore/GTNH/ATM10はユーザー回答により廃止予定。既存生成元は停止中かつ既存backupありの場合にskipし、監視policyは48h鮮度を要求している。これはログsource台帳で一括無効化しない。

最終artifactの所在/世代、容量、同期、checksum、復元可否、保持期限、費用、所有者を確認→最終保管とretired状態の受入→policy変更の順で別change-controlを準備する。既存データの削除承認は得ていない。SHA-256/restore/retentionのnullは実行済みを証明しない（現行report生成元が明示的にnullを出力する点をread-only確認）。#138で追跡する。
