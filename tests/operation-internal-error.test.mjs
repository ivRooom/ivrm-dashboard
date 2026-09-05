import assert from "node:assert/strict";
import test from "node:test";
import { classifyOperationInternalError } from "../apps/web/lib/operation-internal-error.ts";

test("classifies missing configuration without exposing the value", () => {
  assert.equal(
    classifyOperationInternalError(new Error("SUPABASE_SERVICE_ROLE_KEYが設定されていません")),
    "configuration_error",
  );
});

test("classifies AbortSignal timeout", () => {
  const error = new Error("request aborted");
  error.name = "TimeoutError";
  assert.equal(classifyOperationInternalError(error), "rpc_timeout");
});

test("classifies bounded RPC HTTP failures", () => {
  assert.equal(
    classifyOperationInternalError(new Error("Operation RPC claim_mc_main_operation_job failed with status 504")),
    "rpc_http_error",
  );
});

test("classifies invalid RPC response shapes", () => {
  assert.equal(
    classifyOperationInternalError(new Error("Operation claimの応答値が不正です")),
    "rpc_response_invalid",
  );
  assert.equal(classifyOperationInternalError(new SyntaxError("bad json")), "rpc_response_invalid");
});

test("falls back to unexpected_error without reflecting the error message", () => {
  assert.equal(classifyOperationInternalError(new Error("sensitive-looking arbitrary text")), "unexpected_error");
  assert.equal(classifyOperationInternalError("not-an-error"), "unexpected_error");
});
