# Minecraft Metrics Bridge Production Rollout

1. `IVRM_MINECRAFT_PERFORMANCE_ENABLED=false`を確認する。
2. 最新mainで`update-monitoring-stack.sh`を実行する。
3. `stage-minecraft-metrics-bridge.sh`でNeoForge Bridgeを配置する。
4. `mc-main`を通常のメンテナンス手順で再起動する。
5. server logで`[ivrm-metrics-bridge] initialized`を確認する。
6. 15秒以上後に`/data/ivrm/metrics.json`が生成されることを確認する。
7. 12秒空けた2回の確認で`generatedAt`が進むことを確認する。
8. ここまで成功した場合のみPerformanceをONにする。
9. Snapshot、Agent log、Production DB Raw、5分Rollup、`/history`を順に確認する。

`metrics.json`が存在しない状態ではPerformanceをONにしない。
