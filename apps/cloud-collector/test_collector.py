import hashlib
import hmac
import json
import os
import unittest
from unittest.mock import patch, MagicMock
import urllib.error
import collector


class CollectorTest(unittest.TestCase):
    def test_provider_states_do_not_invent_health(self):
        self.assertEqual(collector.state(None, ("RUNNING",)), ("unknown", "provider_error"))
        self.assertEqual(collector.state("STOPPED", ("RUNNING",)), ("outage", "unexpected_state"))

    def test_credentials_missing_and_invalid_are_not_outages(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(collector.CollectionError) as raised:
                collector.api("netlify", "/sites/x", "TOKEN")
        self.assertEqual(raised.exception.code, "not_configured")
        for code, expected in [(401, "auth_error"), (403, "forbidden"), (404, "not_found"), (500, "provider_error")]:
            error = urllib.error.HTTPError("https://example.com", code, "provider text", {}, None)
            try: self.assertEqual(collector.classify(error), expected)
            finally: error.close()

    def test_aws_health_checks_can_degrade_a_running_instance(self):
        boto = MagicMock()
        client = boto.Session.return_value.client.return_value
        client.describe_instances.return_value = {"Reservations": [{"Instances": [{"State": {"Name": "running"}}]}]}
        client.describe_instance_status.return_value = {"InstanceStatuses": [{"InstanceStatus": {"Status": "impaired"}, "SystemStatus": {"Status": "ok"}}]}
        with patch.dict("sys.modules", {"boto3": boto, "botocore": MagicMock(), "botocore.config": MagicMock()}):
            self.assertEqual(collector.aws_check({"provider": "aws", "region": "ap-northeast-1", "resource": "i-example"}), ("degraded", "unexpected_state"))
        client.describe_instances.assert_called_once_with(InstanceIds=["i-example"])

    def test_oci_readonly_key_mode_does_not_override_signer_with_none(self):
        sdk = MagicMock()
        sdk.config.from_file.return_value = {"region": "old"}
        sdk.core.ComputeClient.return_value.get_instance.return_value.data.lifecycle_state = "RUNNING"
        with patch.dict("sys.modules", {"oci": sdk}), patch.dict(os.environ, {"IVRM_CLOUD_OCI_AUTH": "api_key"}):
            self.assertEqual(collector.oci_check({"region": "ap-tokyo-1", "resource": "ocid1.instance.example"}), ("operational", "ok"))
        self.assertNotIn("signer", sdk.core.ComputeClient.call_args.kwargs)

    def test_publication_is_distinct_from_failed_latest_build(self):
        with patch.object(collector, "api", return_value={"published_deploy": {"state": "ready"}, "latestDeploy": {"state": "error"}}):
            self.assertEqual(collector.check({"provider": "netlify", "resource": "x"}, []), ("operational", "ok"))
        with patch.object(collector, "api", return_value={}):
            self.assertEqual(collector.check({"provider": "netlify", "resource": "x"}, []), ("unknown", "provider_error"))

    def test_vercel_checks_the_production_target(self):
        with patch.object(collector, "api", return_value={"targets": {"production": {"readyState": "READY"}}, "latestDeployment": {"readyState": "CANCELED"}}):
            self.assertEqual(collector.check({"provider": "vercel", "resource": "x", "teamId": "y"}, []), ("operational", "ok"))

    def test_dns_requires_exact_record_and_proxy_mode(self):
        target = {"provider": "cloudflare", "kind": "dns", "resource": "zone", "name": "console.ivrm.jp", "recordType": "CNAME", "expectedContent": "example.vercel-dns.com", "expectedProxied": True}
        record = {"name": target["name"], "type": "CNAME", "content": "example.vercel-dns.com.", "proxied": True}
        with patch.object(collector, "api", return_value=[record]):
            self.assertEqual(collector.check(target, []), ("operational", "ok"))
        with patch.object(collector, "api", return_value=[dict(record, proxied=False)]):
            self.assertEqual(collector.check(target, []), ("outage", "dns_mismatch"))

    def test_redirects_are_never_followed(self):
        with self.assertRaises(collector.CollectionError):
            collector.NoRedirect().redirect_request(None, None, 302, "", {}, "http://169.254.169.254")

    def test_http_requires_explicit_public_allowlist(self):
        for url in ["http://example.com", "https://user:pass@example.com", "https://example.com:444", "https://other.com"]:
            with self.assertRaises(ValueError):
                collector.http_check({"url": url}, ["example.com"])
        with patch.object(collector.socket, "getaddrinfo", return_value=[(None, None, None, None, ("127.0.0.1", 443))]):
            with self.assertRaises(collector.CollectionError):
                collector.http_check({"url": "https://example.com"}, ["example.com"])

    def test_one_provider_failure_does_not_drop_other_results_or_leak_secrets(self):
        with patch.object(collector, "check", side_effect=[RuntimeError("sk-secret"), ("operational", "ok")]):
            result = collector.collect({"targets": [{"id": "a"}, {"id": "b"}]})
        self.assertEqual(result[0]["status"], "error")
        self.assertEqual(result[1]["status"], "operational")
        self.assertNotIn("secret", json.dumps(result))

    def test_resource_identifiers_cannot_change_api_paths(self):
        for resource in ["x/y", "x?token=secret", "x#fragment", ""]:
            with self.assertRaises(ValueError): collector.identifier(resource)

    def test_ingest_signature_covers_exact_body(self):
        response = MagicMock()
        response.__enter__.return_value.status = 202
        opener = MagicMock()
        opener.open.return_value = response
        with patch.dict(os.environ, {"IVRM_AGENT_TOKEN": "a" * 32}), patch.object(collector.urllib.request, "build_opener", return_value=opener):
            collector.send({"collectorServerId": "oci-minecraft-01"}, [{"id": "x", "status": "operational", "reasonCode": "ok"}])
        request = opener.open.call_args.args[0]
        headers = {k.lower(): v for k, v in request.header_items()}
        signed = headers["x-ivrm-timestamp"].encode()+b"."+headers["x-ivrm-nonce"].encode()+b"."+request.data
        self.assertEqual(headers["x-ivrm-signature"], hmac.new(b"a"*32, signed, hashlib.sha256).hexdigest())
        self.assertEqual(request.full_url, "https://console.ivrm.jp/api/agent/cloud")


if __name__ == "__main__": unittest.main()
