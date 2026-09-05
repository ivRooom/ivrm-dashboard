export type OperationInternalErrorCode =
  | "configuration_error"
  | "rpc_timeout"
  | "rpc_http_error"
  | "rpc_response_invalid"
  | "unexpected_error";

const RPC_HTTP_ERROR_PATTERN = /^Operation RPC [a-z0-9_]+ failed with status [1-5][0-9]{2}$/;

export function classifyOperationInternalError(error: unknown): OperationInternalErrorCode {
  if (!(error instanceof Error)) return "unexpected_error";

  if (error.name === "TimeoutError") return "rpc_timeout";

  if (
    error.message.endsWith("が設定されていません") ||
    error.message === "SUPABASE_URLがURLではありません" ||
    error.message === "SUPABASE_URLは認証情報を含まないHTTPS URLで指定してください"
  ) {
    return "configuration_error";
  }

  if (RPC_HTTP_ERROR_PATTERN.test(error.message)) return "rpc_http_error";

  if (
    error instanceof SyntaxError ||
    error.message.includes("の応答形式が不正です") ||
    error.message.includes("の応答件数が不正です") ||
    error.message.includes("の応答値が不正です") ||
    error.message === "Agent replay ledgerの応答が不正です"
  ) {
    return "rpc_response_invalid";
  }

  return "unexpected_error";
}
