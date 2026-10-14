import hashlib
import hmac
import json
import unittest
from report import make_request, ENDPOINT


class ReportTests(unittest.TestCase):
    def test_signature_covers_exact_payload_and_fixed_destination(self):
        raw = json.dumps({"kind": "runtime-inventory-v1", "serverId": "aws-app-01", "observedAt": "2026-10-15T00:00:00Z", "containers": []}).encode()
        now = 1792022400
        req = make_request(raw, "aws-app-01", "t"*32, now=now, nonce="a"*32)
        self.assertEqual(req.full_url, ENDPOINT)
        self.assertEqual(req.get_method(), "POST")
        expected = hmac.new(b"t"*32, (str(now)+"."+"a"*32+".").encode()+raw, hashlib.sha256).hexdigest()
        self.assertEqual(req.get_header("X-ivrm-signature"), expected)
        self.assertNotIn("t"*32, str(req.headers))

    def test_stale_snapshot_cross_host_and_oversized_body_are_rejected(self):
        raw = json.dumps({"kind": "runtime-inventory-v1", "serverId": "aws-app-01", "observedAt": "2026-10-15T00:00:00Z", "containers": []}).encode()
        for content, server, now in ((raw,"other",1792022400),(raw,"aws-app-01",1792022521),(b"x"*32769,"aws-app-01",1792022400)):
            with self.assertRaises(ValueError):
                make_request(content, server, "t"*32, now=now)
