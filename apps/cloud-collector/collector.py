"""Read-only cloud collection. Only bounded states are sent to the Console."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class CollectionError(Exception):
    def __init__(self, code):
        self.code = code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CollectionError("provider_error")


def request_json(url, token=None, body=None):
    headers = {"Accept": "application/json", "User-Agent": "IVRM-Cloud-Collector/1"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise CollectionError("provider_error")
        return json.loads(raw)


def api(provider, path, token_env, query=None):
    token = os.environ.get(token_env, "").strip()
    if not token:
        raise CollectionError("not_configured")
    base = {"vercel": "https://api.vercel.com", "netlify": "https://api.netlify.com/api/v1",
            "cloudflare": "https://api.cloudflare.com/client/v4"}[provider]
    suffix = "?" + urllib.parse.urlencode(query) if query else ""
    result = request_json(base + path + suffix, token)
    if provider == "cloudflare":
        if not result.get("success"):
            raise CollectionError("provider_error")
        return result["result"]
    return result


def identifier(value):
    # No resource identifier may become a query, fragment, or a new API path.
    if not isinstance(value, str) or not value or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-" for c in value):
        raise ValueError("invalid_resource_identifier")
    return value


def state(value, healthy, transitional=()):
    if value in healthy:
        return "operational", "ok"
    if value in transitional:
        return "degraded", "unexpected_state"
    if value is None:
        return "unknown", "provider_error"
    return "outage", "unexpected_state"


def aws_check(target):
    import boto3
    from botocore.config import Config
    config = Config(connect_timeout=5, read_timeout=10, retries={"total_max_attempts": 2, "mode": "standard"})
    session = boto3.Session(region_name=target["region"])
    resource = identifier(target["resource"])
    if target["provider"] == "lightsail":
        instance = session.client("lightsail", config=config).get_instance(instanceName=resource)["instance"]
        return state(instance["state"]["name"], ("running",), ("pending", "starting", "rebooting"))
    client = session.client("ec2", config=config)
    reservations = client.describe_instances(InstanceIds=[resource])["Reservations"]
    instances = [item for reservation in reservations for item in reservation["Instances"]]
    if not instances:
        raise CollectionError("not_found")
    status = state(instances[0]["State"]["Name"], ("running",), ("pending",))
    if status[0] != "operational":
        return status
    checks = client.describe_instance_status(InstanceIds=[resource], IncludeAllInstances=True)["InstanceStatuses"]
    if not checks:
        return "unknown", "provider_error"
    for name in ("InstanceStatus", "SystemStatus"):
        if checks[0][name]["Status"] != "ok":
            return "degraded", "unexpected_state"
    return status


def oci_check(target):
    import oci
    region = target["region"]
    auth = os.environ.get("IVRM_CLOUD_OCI_AUTH", "instance_principal")
    if auth == "instance_principal":
        signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
        config = {"region": region}
    elif auth == "api_key":
        config = oci.config.from_file(os.environ.get("OCI_CONFIG_FILE", "~/.oci/config"),
                                      os.environ.get("OCI_CONFIG_PROFILE", "IVROOOM_MCP_READONLY"))
        config["region"] = region
        signer = None
    else:
        raise CollectionError("not_configured")
    client = oci.core.ComputeClient(config, timeout=(5, 10), retry_strategy=oci.retry.NoneRetryStrategy(),
                                    **({"signer": signer} if signer else {}))
    return state(client.get_instance(identifier(target["resource"])).data.lifecycle_state,
                 ("RUNNING",), ("STARTING", "PROVISIONING"))


def http_check(target, allowed_hosts):
    url = urllib.parse.urlsplit(target["url"])
    if url.scheme != "https" or url.username or url.password or url.port not in (None, 443) or url.hostname not in allowed_hosts or url.fragment:
        raise ValueError("http_target_not_allowed")
    addresses = socket.getaddrinfo(url.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise CollectionError("provider_error")
    try:
        response = urllib.request.build_opener(NoRedirect()).open(
            urllib.request.Request(target["url"], headers={"User-Agent": "Mozilla/5.0 (compatible; IVRMCloudMonitor/1)"}), timeout=10)
    except urllib.error.HTTPError as error:
        error.close()
        return "outage", "unexpected_state"
    with response:
        return state(response.status, (200,))


def check(target, allowed_hosts):
    provider = target["provider"]
    if provider in ("aws", "lightsail"):
        return aws_check(target)
    if provider == "oci":
        return oci_check(target)
    if provider == "http":
        return http_check(target, allowed_hosts)
    resource = identifier(target["resource"])
    if provider == "vercel":
        # targets.production can refer to a canceled build while the domain still
        # serves an older READY deployment. Follow the configured public alias.
        alias = identifier(target["productionAlias"])
        query = {"teamId": identifier(target["teamId"])}
        assigned = api("vercel", "/v4/aliases/" + alias, "IVRM_CLOUD_VERCEL_TOKEN", {**query, "projectId": resource})
        deployment_id = (assigned.get("deployment") or {}).get("id")
        if assigned.get("projectId") != resource or not deployment_id:
            return "unknown", "provider_error"
        deployment = api("vercel", "/v13/deployments/" + identifier(deployment_id), "IVRM_CLOUD_VERCEL_TOKEN", query)
        if deployment.get("projectId") != resource:
            return "unknown", "provider_error"
        return state(deployment.get("readyState"), ("READY",), ("BUILDING", "INITIALIZING", "QUEUED"))
    if provider == "netlify":
        site = api("netlify", "/sites/" + resource, "IVRM_CLOUD_NETLIFY_TOKEN")
        return state((site.get("published_deploy") or {}).get("state"), ("ready",), ("building", "uploading", "processing"))
    if provider == "cloudflare":
        if target["kind"] == "tunnel":
            tunnel = api("cloudflare", "/accounts/" + identifier(target["accountId"]) + "/cfd_tunnel/" + resource, "IVRM_CLOUD_CLOUDFLARE_TOKEN")
            return state(tunnel.get("status"), ("healthy",), ("degraded",))
        records = api("cloudflare", "/zones/" + resource + "/dns_records", "IVRM_CLOUD_CLOUDFLARE_TOKEN",
                      {"name": target["name"], "type": target["recordType"], "per_page": 100})
        matches = [r for r in records if r["name"] == target["name"] and r["type"] == target["recordType"]]
        valid = len(matches) == 1 and matches[0]["content"].rstrip(".") == target["expectedContent"].rstrip(".") and matches[0]["proxied"] == target["expectedProxied"]
        return ("operational", "ok") if valid else ("outage", "dns_mismatch")
    raise ValueError("unsupported_provider")


def classify(error):
    if isinstance(error, CollectionError):
        return error.code
    if isinstance(error, (ImportError, FileNotFoundError)):
        return "not_configured"
    if isinstance(error, (TimeoutError, socket.timeout)):
        return "timeout"
    if isinstance(error, urllib.error.URLError) and isinstance(error.reason, (TimeoutError, socket.timeout)):
        return "timeout"
    status = getattr(error, "code", None) or getattr(error, "status", None)
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode", status)
        if response.get("Error", {}).get("Code") in ("NoCredentialsError", "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId", "UnrecognizedClientException"):
            return "auth_error"
    if type(error).__name__ in ("NoCredentialsError", "PartialCredentialsError", "TokenRetrievalError"):
        return "auth_error"
    return {401: "auth_error", 403: "forbidden", 404: "not_found"}.get(status, "provider_error")


def collect(config):
    results = []
    for target in config["targets"]:
        try:
            status, code = check(target, config.get("allowedHttpHosts", []))
        except Exception as error:
            # SDK exceptions and provider responses may contain secrets. Never serialize them.
            status, code = "error", classify(error)
        results.append({"id": target["id"], "status": status, "reasonCode": code})
    return results


def send(config, results):
    token = os.environ.get("IVRM_AGENT_TOKEN", "")
    if len(token) < 32:
        raise CollectionError("not_configured")
    url = "https://console.ivrm.jp/api/agent/cloud"
    envelope = {"kind": "cloud-monitor-v1", "serverId": config["collectorServerId"],
                "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "results": results}
    body = json.dumps(envelope, separators=(",", ":")).encode()
    timestamp, nonce = str(int(time.time())), secrets.token_hex(16)
    signature = hmac.new(token.encode(), timestamp.encode()+b"."+nonce.encode()+b"."+body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "User-Agent": "ivrm-agent/cloud-monitor-v1",
        "X-IVRM-Agent-ID": config["collectorServerId"], "X-IVRM-Timestamp": timestamp,
        "X-IVRM-Nonce": nonce, "X-IVRM-Signature": signature})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
        if response.status != 202:
            raise CollectionError("provider_error")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        targets = config["targets"]
        if not isinstance(config.get("collectorServerId"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", config["collectorServerId"]):
            raise ValueError("invalid_collector")
        if not isinstance(targets, list) or not 1 <= len(targets) <= 50 or len({t["id"] for t in targets}) != len(targets) or any(
            not isinstance(t.get("id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", t["id"]) for t in targets):
            raise ValueError("invalid_targets")
        results = collect(config)
        if args.dry_run:
            print(json.dumps({"results": results}))
        else:
            send(config, results)
            print(json.dumps({"accepted": True, "targets": len(results)}))
        return int(any(r["status"] in ("error", "unknown") for r in results))
    except Exception:
        print(json.dumps({"accepted": False, "error": "collector_failed"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
