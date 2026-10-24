# Minecraft 隔離復元・復旧手順

作成: 2026-10-25 / #117, #138 / **手順準備済み、今回の復元試験は未実施**

## 事前条件

owner、選ぶartifactとobject version、RPO/RTO目標、保存先、復号権限、必要容量を特定する。mainは約0.982GBの圧縮archiveだが展開容量を同一視しない。read-only metadataでstorage classと取り出し状態を確認し、GLACIER/DEEP_ARCHIVEのrestore request・GET・転送・computeを含む費用/所要時間を見積もって承認後に実行する。新serverを作る場合も別費用承認が必要。

本番のworld mount・volume・ports・外部Bot/API・DB・本番Secretから分離した復元先を明記する。対象hostのARM64/CPU/RAMと検証JVM Xmx/native memory、Java/loader/Minecraft/MOD互換を確認する。空き容量不足なら中断し、本番backupを削って空けない。

## 検証の順番

1. 選択artifact/versionを固定し、取得開始/完了/byte数を記録。local SHA-256を計算する。信頼できる生成時manifestまたは保存object/versionに紐づいたremote checksumと照合し、multipart ETagをSHA-256と扱わない。manifest自体の真正性/権限境界も確認する。元の期待hashがない既存archiveの新しいlocal hashだけではremote検証成功としない。
2. archiveを実行せずに一覧検査。絶対path、`..` traversal、危険なsymlink/hardlink、想定外device等は拒否し、専用の低権限展開先を使う。archive内のscriptやcomposeを無検査で実行しない。world/playerdata/config/MOD/権限・image digestの有無を確認し、欠損は記録する。
3. 承認した隔離先へ展開。正確なJava/loader/MODとimageで起動し、本番への経路が遮断されていることを再確認。live volumeへcopy/mountしない。Secretは本番と分離した検証用値を承認された配送経路で使う。
4. 起動/ログ/Docker healthyに加えて、テストユーザーのlogin、位置/teleport、inventory、権限、主要MOD handshake、chunk・world整合、TPS/MSPT、JVM GC/OOMを確認する。負荷は事前上限を守る。
5. artifact単位のchecksumと、実際に試したRunのrestoreTestedAt、policy、開始/終了、RPO/RTO実測、検証version、失敗項目を記録する。9/7のPolicy証拠を最新artifactの試験済みにコピーしない。
6. 検証済み事実だけ既存reporter契約へ反映する変更を準備し、承認後に送信。sha256Verified/restoreTestedAt/retentionExpiresAtを架空のtrue/日時で埋めない。無期限保持の証明は現契約の将来日時へ偽装せず、契約拡張を別途設計する。

## 本番復旧（独立したmaintenance）

本番停止/上書きはこの手順書の作成で許可されない。復元試験とrollbackを確認後、対象・maintenance window・書込停止・最終backup・受入・告知・失敗時の戻し先を明記して承認を得る。旧world/volumeと障害時点データを保全する。

writer/プレイヤー受付を止め、最終状態を保全してから選択した復元点へ切替。game login/権限/MOD/TPSに加え、proxy/routing/activity連携と二重送信の有無を確認する。新worldへの書込再開後は単純な旧volume戻しをrollbackとせず、差分の保全/回収方針を決める。

## 後片付けと中断

失敗時は試験結果をfailure/unknownとして残す。本番へ自動切替・再試行しない。cleanup対象は今回作った検証資源のID/label/pathと一致するものだけ。resolved absolute pathが専用workspace内であることを確認してから削除し、元archive/本番volume/監査記録を対象にしない。paid resourceを作った場合は停止と削除、残volume/snapshot/storage課金も確認する。
