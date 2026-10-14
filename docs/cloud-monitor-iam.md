# Cloud MonitorのAWS読み取り権限

アプリ変更PR #121と分離したインフラ変更。対象はアカウント911291529944、東京リージョンの既存EC2ロールivrm-ec2-role。

既存ロールはCloudFormationのivrm-compute-access-foundationが管理している。補助スタックivrm-cloud-monitor-readはAWS::IAM::Policyを1個だけ管理し、既存ロール・Instance Profile・既存inline/managed policiesの定義は変更しない。Terraform管理リソースは変更しない。

追加するアクションはec2:DescribeInstances、ec2:DescribeInstanceStatus、lightsail:GetInstanceだけ。3アクションはリソースレベル権限に対応しないためResourceは*、RequestedRegionはap-northeast-1に限定する。対象IDの固定はCollector設定の責務。同じ東京の別インスタンスの参照をIAMで禁止するものではない。起動・停止・Lightsailの接続キー取得・IAM変更は許可しない。

CloudFormationのAWS::*リソース操作に追加料金はなく、IAMポリシーだけでVM・ログ・有料機能を作成しない。Collectorの継続実行とその通信費は別に検証・承認する。このスタックの適用だけでは収集処理は開始されない。

## 適用

PR/CI/レビュー後、deploy/aws/cloud-monitor-read.jsonのSHAを固定してvalidate-template、CREATE Change Setを作成する。ResourceChangeがCloudMonitorReadPolicyのAddだけであることを確認してからexecute-change-setする。既存ロールや他リソースの変更・置換が出た場合は実行しない。CAPABILITY_NAMED_IAMを明示する。

## 検証と復旧

SimulateCustomPolicyで東京の参照3アクションがallowed、別リージョン・起動停止・キー取得・IAM変更がimplicitDenyを確認する。適用後はEC2のInstance Roleで参照だけを実行する。権限確認のための起動・停止はしない。

復旧はivrm-cloud-monitor-readスタックを削除し、この追加ポリシーだけを外す。既存ロール・VM・データ・他の権限を削除しない。Collectorが動作している場合は先に専用Timerを停止する。

料金根拠: https://aws.amazon.com/cloudformation/pricing/ 。アクションの権限仕様: https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html 、https://docs.aws.amazon.com/service-authorization/latest/reference/list_lightsail.html 。
