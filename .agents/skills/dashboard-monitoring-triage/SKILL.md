---
name: dashboard-monitoring-triage
description: ivrm-dashboardのGo Agent・Collector・Vercel/Supabase・Minecraft/TPS・クラウド監視で異常/未観測を切り分ける。障害やコスト/容量調査に使う。
---

# Dashboard Monitoring Triage

## Source of Truth

- 現行 `README.md`、`docs/architecture.md`、`docs/oci-docker-monitoring.md`、`docs/service-operations.md`、`docs/monitoring-history.md`、`apps/web/lib/service-catalog.ts`、最新Issue/PR/CIを確認。
- 共通 [observability-investigation](https://github.com/ivRooom/ivrm-platform/blob/main/.agents/skills/observability-investigation/SKILL.md)、[incident-response](https://github.com/ivRooom/ivrm-platform/blob/main/.agents/skills/incident-response/SKILL.md)、[tool-access-and-mcp](https://github.com/ivRooom/ivrm-platform/blob/main/.agents/skills/tool-access-and-mcp/SKILL.md)を組み合わせる。

## 切り分け手順

1. 影響Service、Host、Environment、時間帯、検知元、最新DeployとMaintenance予定を確定。Service Catalogとホストの実Container/Caddy mappingを照合し、ドメインからContainerを推測しない。
2. `expected running/stopped/absent` と `maintenance_mode` を判定してから、observed running/health/restart/OOMと比較。stale・unknown・未収集をhealthyと見なさない。
3. Collector→HMAC/Nonce送信→API→Supabase→Web UIの経路を分解。read-onlyでheartbeat時刻・遅延・DB保存・API responseを比較。
4. Minecraft TPS/MSPTはSpark Bridgeの構造化メトリクスと鮮度を確認。Ping、Player数、CPU使用量からTPSを推定しない。メトリクス未取得でもHost/Status確認は継続。
5. Runtime Inventoryは固定host/container allowlist、payload上限、RLS、最新1行upsertの安全境界を守る。コードの存在と本番Flag/Timerの有効化を同一視しない。
6. 新たな時系列収集の提案時にはDB容量、保持期間、cardinality、API/egrress、Vercel/OCIの料金を計算。追加収集で既存監視が詰まるのを避ける。
7. 可用性だけでなくbackup age/restore、queue/ingest lag、notification delivery、read-only log report、依存APIを確認。

## 読取手段と検証

- GitHub: latest code / Issue / PR / CI。Vercel・Supabase・クラウド接続は**利用できるtoolで必要scopeをread-only検証してから**利用。未接続ならoperator向け診断手順を示し、調査済みと報告しない。
- `pnpm install --frozen-lockfile` 後、変更に応じ `pnpm check`、`pnpm build`、`pnpm agent:test`、`apps/runtime-collector` のPython unitテストを実行（実施済みのみ記録）。
- 本番Agent/Timer/DB migration/収集Flag変更は対象別Change Planと明示承認が必要。Docker socket、SSH、RCON、environmentをブラウザや外部へ公開しない。

## 結果

検知/根拠（timestamp、source）、observed/expected、影響・severity、確定/推測/未知、緩和策、復旧判定、監視欠測、コスト、関連Issueを記録。
