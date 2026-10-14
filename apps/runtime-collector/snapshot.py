"""Bounded, read-only Docker runtime inventory; no environment or shell output."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import os
from pathlib import Path
import tempfile

PROFILES = {
    "aws-app-01": ("ivrm-admin", "ivrm-api", "ivrm-home", "ivrm-member", "ivrm-contact", "ivrm-cloudflared", "ivrm-runtime-caddy", "ivrm-runtime-health"),
    "lightsail-herta": ("herta-api-1", "herta-studio-1", "herta-worker-1", "herta-bot-1", "herta-postgres-1", "herta-redis-1", "herta-caddy-1", "herta-nginx-1"),
    "oci-minecraft-01": ("mc-main", "ivrm-velocity", "mc-resource-router", "ivrm-status-api", "caddy"),
}
STATES = {"created", "running", "paused", "restarting", "removing", "exited", "dead"}
HEALTH = {"starting", "healthy", "unhealthy", "none"}
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,254}$")
# Docker performs the projection, so the subprocess never emits Config.Env or labels.
INSPECT_FORMAT = '{"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"restartCount":{{.RestartCount}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}},"image":{{json .Config.Image}},"imageId":{{json .Image}}}'


def read_command(argv):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=15, check=False,
                            env={"PATH": "/usr/bin:/bin", "DOCKER_HOST": "unix:///var/run/docker.sock"})
    if result.returncode != 0 or len(result.stdout) > 32768:
        raise ValueError("docker_read_failed")
    return json.loads(result.stdout)


def integer(value, maximum=9_007_199_254_740_991):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
        raise ValueError("invalid_docker_response")
    return value


def normalize(document):
    if not isinstance(document, dict) or set(document) != {"state", "health", "restartCount", "oomKilled", "exitCode", "image", "imageId"}:
        raise ValueError("invalid_docker_response")
    if document["state"] not in STATES or document["health"] not in HEALTH or type(document["oomKilled"]) is not bool:
        raise ValueError("invalid_docker_response")
    if not isinstance(document["image"], str) or not IMAGE.fullmatch(document["image"]):
        raise ValueError("invalid_docker_response")
    if not isinstance(document["imageId"], str) or not DIGEST.fullmatch(document["imageId"]):
        raise ValueError("invalid_docker_response")
    return {"state": document["state"], "health": document["health"],
            "restartCount": integer(document["restartCount"], 2_147_483_647),
            "oomKilled": document["oomKilled"], "exitCode": integer(document["exitCode"], 255),
            "image": document["image"], "imageId": document["imageId"]}


def collect(server_id, reader=read_command):
    if server_id not in PROFILES:
        raise ValueError("unknown_server")
    containers = []
    for name in PROFILES[server_id]:
        try:
            entry = normalize(reader(["/usr/bin/docker", "container", "inspect", "--format", INSPECT_FORMAT, name]))
            entry["collection"] = "ok"
        except (ValueError, TypeError, KeyError, subprocess.TimeoutExpired, OSError):
            # Missing container, denied Docker access and malformed responses are unknown,
            # never converted to a successful or stopped observation.
            entry = {"collection": "unavailable"}
        containers.append({"name": name, **entry})
    return {"kind": "runtime-inventory-v1", "serverId": server_id,
            "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "containers": containers}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--server-id", required=True, choices=tuple(PROFILES))
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    output = json.dumps(collect(args.server_id), separators=(",", ":"))
    if args.write:
        import grp
        directory = Path("/run/ivrm-agent")
        fd, temporary = tempfile.mkstemp(prefix=".runtime-", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                os.fchmod(stream.fileno(), 0o640)
                os.fchown(stream.fileno(), 0, grp.getgrnam("ivrm-agent").gr_gid)
                stream.write(output)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, directory / "runtime-inventory.json")
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    else:
        print(output)
