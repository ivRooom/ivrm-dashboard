# Minecraft Metrics Bridge / NeoForge

Production `mc-main` はNeoForgeで稼働し、Sparkも`*-neoforge.jar`としてロードされます。IVRM Metrics BridgeもNeoForge `javafml` entrypointとしてロードします。

## Rollout gate

1. `IVRM_MINECRAFT_PERFORMANCE_ENABLED=false`を確認する。
2. `stage-minecraft-metrics-bridge.sh`でNeoForge Bridge JARを`/data/mods`へ配置する。
3. `mc-main`を通常のメンテナンス手順で再起動する。
4. server logに`[ivrm-metrics-bridge] initialized`が出ることを確認する。
5. `/data/ivrm/metrics.json`が生成され、`generatedAt`が10秒周期で進むことを確認する。
6. ここまで成功した場合だけPerformanceをONにする。

Bridge JARの配置だけではmodはロードされません。Minecraft/NeoForgeの再起動が必要です。

`metrics.json`が存在しない、または`initialized`ログが出ない場合はPerformanceをONにせず、Loader/metadata/entrypointを確認します。
