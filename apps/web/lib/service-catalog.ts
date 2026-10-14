/** Reviewed deployment topology. Container names are identifiers, never shell input. */
export type BrandService = {
  id: string;
  domain: string;
  label: string;
  provider: string;
  serverId: string | null;
  containers: readonly string[];
  dependencies: readonly string[];
  cloudTargets: readonly string[];
  publicTarget: string | null;
  operationTarget: "mc-main" | null;
};

const runtime = ["ivrm-cloudflared", "ivrm-runtime-caddy"] as const;
export const BRAND_SERVICES: readonly BrandService[] = [
  { id: "minecraft", domain: "mc.ivrm.jp", label: "Minecraft", provider: "OCI", serverId: "oci-minecraft-01", containers: ["mc-main", "ivrm-velocity"], dependencies: [], cloudTargets: ["oci-minecraft"], publicTarget: null, operationTarget: "mc-main" },
  { id: "member", domain: "member.ivrm.jp", label: "Member", provider: "AWS EC2", serverId: "aws-app-01", containers: ["ivrm-member"], dependencies: ["ivrm-api", ...runtime], cloudTargets: ["aws-app", "cloudflare-runtime-tunnel"], publicTarget: "http-member", operationTarget: null },
  { id: "admin", domain: "admin.ivrm.jp", label: "Admin", provider: "AWS EC2", serverId: "aws-app-01", containers: ["ivrm-admin"], dependencies: ["ivrm-api", ...runtime], cloudTargets: ["aws-app", "cloudflare-runtime-tunnel"], publicTarget: "http-admin", operationTarget: null },
  { id: "herta", domain: "herta.ivrm.jp", label: "Herta", provider: "AWS Lightsail", serverId: "lightsail-herta", containers: ["herta-api-1", "herta-studio-1", "herta-worker-1", "herta-bot-1"], dependencies: ["herta-postgres-1", "herta-redis-1", "herta-caddy-1", "herta-nginx-1"], cloudTargets: ["lightsail-herta"], publicTarget: "http-herta", operationTarget: null },
  { id: "home", domain: "ivrm.jp", label: "IVRM Home", provider: "AWS EC2", serverId: "aws-app-01", containers: ["ivrm-home"], dependencies: runtime, cloudTargets: ["aws-app", "cloudflare-runtime-tunnel"], publicTarget: "http-ivrm-home", operationTarget: null },
  { id: "api", domain: "api.ivrm.jp", label: "IVRM API", provider: "AWS EC2", serverId: "aws-app-01", containers: ["ivrm-api"], dependencies: runtime, cloudTargets: ["aws-app", "cloudflare-runtime-tunnel"], publicTarget: "http-api", operationTarget: null },
  { id: "console", domain: "console.ivrm.jp", label: "Operations Console", provider: "Vercel", serverId: null, containers: [], dependencies: [], cloudTargets: ["vercel-console", "cloudflare-console-dns"], publicTarget: "http-console", operationTarget: null },
  { id: "ivmz", domain: "ivmz.ivrm.jp", label: "ivmz Home", provider: "Netlify", serverId: null, containers: [], dependencies: [], cloudTargets: ["netlify-home"], publicTarget: "http-home", operationTarget: null },
];

export type ServiceHealth = "operational" | "attention" | "unknown";
/** Missing, disabled and stale checks cannot establish successful service health. */
export function combineServiceHealth(states: readonly ServiceHealth[]): ServiceHealth {
  if (states.includes("attention")) return "attention";
  return states.length > 0 && states.every(state => state === "operational") ? "operational" : "unknown";
}
