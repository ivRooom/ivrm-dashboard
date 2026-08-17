# NeoForge Bridge correction

PR #63のBridgeはFabric entrypointだったため、Production NeoForge serverではロードされませんでした。この修正ではNeoForge `javafml` / `@Mod` entrypointへ移行し、Spark APIからの構造化TPS/MSPT収集ロジックは維持します。
