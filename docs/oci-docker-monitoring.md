# OCI Docker状態監視の配置

Docker Socketを非特権の`ivrm-agent`へ渡さず、rootで動く短時間のsystemd oneshotが許可済みコンテナだけを`docker inspect`します。収集結果は機密情報を除いたJSONとして`/run/ivrm-agent/docker-state.json`へ書き出し、Go Agentはそのファイルだけを読み取ります。

## 構成

```text
root / systemd timer（10秒）
  └─ docker inspect（許可済み3コンテナのみ）
       └─ /run/ivrm-agent/docker-state.json
            └─ ivrm-agent（非特権）
                 └─ HTTPS Heartbeat
```

Agentを`docker`グループへ追加しません。Docker Socket、環境変数、Mount、IP、ログ本文は外部へ送信しません。

## 対象

`/etc/ivrm-agent/docker.env`で次のコンテナだけを許可します。

```env
IVRM_DOCKER_CONTAINERS=mc-main,mc-resource,mc-resource-router
IVRM_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json
IVRM_DOCKER_BINARY=/usr/bin/docker
```

## 配置

リポジトリを取得したディレクトリで実行します。

```bash
sudo install -d -o root -g root -m 755 /usr/local/libexec
sudo install -o root -g root -m 755 \
  deploy/oci/ivrm-agent-docker-snapshot.py \
  /usr/local/libexec/ivrm-agent-docker-snapshot

sudo install -o root -g root -m 644 \
  deploy/oci/ivrm-agent-docker-snapshot.service \
  /etc/systemd/system/ivrm-agent-docker-snapshot.service

sudo install -o root -g root -m 644 \
  deploy/oci/ivrm-agent-docker-snapshot.timer \
  /etc/systemd/system/ivrm-agent-docker-snapshot.timer

sudo install -o root -g root -m 644 \
  deploy/oci/ivrm-agent.tmpfiles.conf \
  /etc/tmpfiles.d/ivrm-agent.conf

sudo install -o root -g root -m 600 \
  deploy/oci/docker.env.example \
  /etc/ivrm-agent/docker.env
```

実際のコンテナ名が異なる場合は、root権限で`/etc/ivrm-agent/docker.env`だけを修正します。

Runtimeディレクトリを作成します。

```bash
sudo systemd-tmpfiles --create /etc/tmpfiles.d/ivrm-agent.conf
```

Go Agentの環境ファイルへスナップショットパスを追加します。

```bash
sudo grep -q '^IVRM_AGENT_DOCKER_SNAPSHOT_PATH=' /etc/ivrm-agent/agent.env \
  || printf '%s\n' \
    'IVRM_AGENT_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json' \
  | sudo tee -a /etc/ivrm-agent/agent.env >/dev/null
```

## 起動

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ivrm-agent-docker-snapshot.timer
sudo systemctl start ivrm-agent-docker-snapshot.service
```

スナップショットを確認します。内容にSecret、環境変数、Mount、IPは含まれません。

```bash
sudo cat /run/ivrm-agent/docker-state.json
```

Agentバイナリを`0.3.0`へ更新した後、再起動します。

```bash
sudo systemctl restart ivrm-agent
```

## 確認

```bash
sudo systemctl status ivrm-agent-docker-snapshot.timer --no-pager -l
sudo journalctl -u ivrm-agent-docker-snapshot.service -n 20 --no-pager -l
sudo journalctl -u ivrm-agent -n 20 --no-pager -l
```

Agentの成功ログには送信したコンテナ数が記録されます。

```text
"msg":"Heartbeatを送信しました","containers":3
```

## 障害時の挙動

- Docker停止・権限エラー・不正な応答時は新しいスナップショットを作成しません。
- スナップショットが45秒より古い場合、Agentはコンテナ配列を送信せずHost Heartbeatだけを継続します。
- 指定コンテナが存在しない場合は`not_found`として保存します。
- Docker監視の障害でMinecraftコンテナを停止・再起動する処理はありません。
