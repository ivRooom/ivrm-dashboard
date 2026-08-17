# Minecraft Metrics Bridge Loader Migration

Production `mc-main` ではSparkがNeoForge版としてロードされているため、IVRM Metrics BridgeもNeoForge `javafml` entrypointを使用します。

## 検証条件

- JARに`META-INF/neoforge.mods.toml`が存在する。
- JARに`fabric.mod.json`を含めない。
- `jp.ivrm.metrics.IvrmMetricsBridge`が`@Mod("ivrm_metrics_bridge")`を持つ。
- public constructorは引数なし1つだけ。
- compile-time NeoForge stubはJARへ含めない。
- `mc-main`再起動後に`[ivrm-metrics-bridge] initialized`が1回出る。
- `/data/ivrm/metrics.json`の`generatedAt`が10秒周期で更新される。
- JSON確認前にPerformanceをONにしない。
