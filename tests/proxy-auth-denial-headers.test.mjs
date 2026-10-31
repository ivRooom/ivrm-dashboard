import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const proxySource = readFileSync(
  new URL("../apps/web/proxy.ts", import.meta.url),
  "utf8",
);

for (const functionName of ["accessError", "discordAuthenticationRequired"]) {
  test(`proxy ${functionName} never caches credential-dependent denials`, () => {
    const start = proxySource.indexOf(`function ${functionName}(`);
    assert.notEqual(start, -1, `missing ${functionName}`);
    const headerDeclaration = proxySource.slice(start).match(/const headers = \{([\s\S]*?)\};/);
    assert.ok(headerDeclaration, `missing denial headers in ${functionName}`);
    const headers = headerDeclaration[1];
    assert.match(headers, /"Cache-Control":\s*"private, no-store, max-age=0"/);
    assert.match(headers, /"Vary":\s*"Cookie"/);
    assert.match(headers, /"X-Content-Type-Options":\s*"nosniff"/);
  });
}
