import {
  canPerformConsoleAction,
  type ConsoleRole,
  type ConsoleSession,
} from "./console-auth";

export type OperationType =
  | "save_world"
  | "restart_backend"
  | "restart_proxy"
  | "start_backend"
  | "stop_backend"
  | "maintenance_start"
  | "maintenance_end"
  | "create_backup"
  | "verify_backup";

export type OperationRisk = "low" | "medium" | "high" | "critical";

export type OperationDefinition = {
  type: OperationType;
  label: string;
  description: string;
  requiredRole: ConsoleRole;
  risk: OperationRisk;
  requiresConfirmation: boolean;
  confirmationPhrase: string | null;
  lockCategory: "world" | "exclusive" | "maintenance";
};

export type OperationCapability = Omit<
  OperationDefinition,
  "confirmationPhrase"
> & {
  allowed: boolean;
};

export const OPERATION_DEFINITIONS: readonly OperationDefinition[] = [
  {
    type: "save_world",
    label: "ワールド保存",
    description: "ワールドデータをディスクへ安全に保存する要求です。",
    requiredRole: "operator",
    risk: "low",
    requiresConfirmation: false,
    confirmationPhrase: null,
    lockCategory: "world",
  },
  {
    type: "restart_backend",
    label: "ゲームサーバー再起動",
    description: "保存と状態確認を前提にMinecraftバックエンドを再起動します。",
    requiredRole: "operator",
    risk: "high",
    requiresConfirmation: true,
    confirmationPhrase: "RESTART",
    lockCategory: "exclusive",
  },
  {
    type: "restart_proxy",
    label: "Velocity再起動",
    description: "公開接続を受け付けるVelocityプロキシを再起動します。",
    requiredRole: "administrator",
    risk: "critical",
    requiresConfirmation: true,
    confirmationPhrase: "RESTART PROXY",
    lockCategory: "exclusive",
  },
  {
    type: "start_backend",
    label: "ゲームサーバー起動",
    description: "停止中のMinecraftバックエンドを起動します。",
    requiredRole: "operator",
    risk: "medium",
    requiresConfirmation: false,
    confirmationPhrase: null,
    lockCategory: "exclusive",
  },
  {
    type: "stop_backend",
    label: "ゲームサーバー停止",
    description: "Minecraftバックエンドを停止し、新規接続を受け付けない状態にします。",
    requiredRole: "administrator",
    risk: "critical",
    requiresConfirmation: true,
    confirmationPhrase: "STOP",
    lockCategory: "exclusive",
  },
  {
    type: "maintenance_start",
    label: "メンテナンス開始",
    description: "管理画面と公開ステータスでメンテナンス中として扱う要求です。",
    requiredRole: "operator",
    risk: "medium",
    requiresConfirmation: false,
    confirmationPhrase: null,
    lockCategory: "maintenance",
  },
  {
    type: "maintenance_end",
    label: "メンテナンス終了",
    description: "HealthとMinecraft Pingの確認後にメンテナンス状態を解除します。",
    requiredRole: "operator",
    risk: "medium",
    requiresConfirmation: false,
    confirmationPhrase: null,
    lockCategory: "maintenance",
  },
  {
    type: "create_backup",
    label: "バックアップ作成",
    description: "構成・ワールド・LuckPermsを対象とするバックアップ要求です。",
    requiredRole: "operator",
    risk: "medium",
    requiresConfirmation: false,
    confirmationPhrase: null,
    lockCategory: "exclusive",
  },
  {
    type: "verify_backup",
    label: "バックアップ検証",
    description: "SHA-256と圧縮ファイルの整合性を検証する要求です。",
    requiredRole: "operator",
    risk: "low",
    requiresConfirmation: false,
    confirmationPhrase: null,
    lockCategory: "exclusive",
  },
] as const;

const OPERATION_TYPES = new Set<OperationType>(
  OPERATION_DEFINITIONS.map((definition) => definition.type),
);

export function isOperationType(value: unknown): value is OperationType {
  return typeof value === "string" && OPERATION_TYPES.has(value as OperationType);
}

export function getOperationDefinition(
  operationType: OperationType,
): OperationDefinition {
  const definition = OPERATION_DEFINITIONS.find(
    (candidate) => candidate.type === operationType,
  );
  if (!definition) {
    throw new Error("未定義の管理操作です");
  }
  return definition;
}

export function getOperationCapabilities(
  session: ConsoleSession,
): OperationCapability[] {
  return OPERATION_DEFINITIONS.map(
    ({ confirmationPhrase: _confirmationPhrase, ...definition }) => ({
      ...definition,
      allowed: canPerformConsoleAction(session, definition.requiredRole),
    }),
  );
}

export function validateOperationPayload(value: unknown): Record<string, never> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 0
  ) {
    throw new Error("この操作ではパラメータを指定できません");
  }
  return {};
}

export function validateOperationConfirmation(
  operationType: OperationType,
  confirmation: unknown,
): boolean {
  const definition = getOperationDefinition(operationType);
  if (!definition.requiresConfirmation) {
    return confirmation === undefined || confirmation === null || confirmation === "";
  }
  return (
    typeof confirmation === "string" &&
    confirmation === definition.confirmationPhrase
  );
}

export function validateIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error("Idempotency Keyが不正です");
  }
  return value;
}
