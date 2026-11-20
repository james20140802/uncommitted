import {
  formatMissingSecretMessage,
  KEYCHAIN_ACCOUNT,
  type KeychainRunner,
  loadConfigRecord,
  readSecret,
  removeConfigSecrets,
  type SecretSpec,
  updateGlobalConfig,
  writeConfigSecret
} from "./keychain-store.js";
import { isRecord } from "./type-guards.js";

/**
 * Instagram account connection (UNC-293): a never-expiring Meta System User
 * token (Unified login) against graph.facebook.com. No OAuth, no refresh.
 */

export const GRAPH_API_VERSION = "v24.0";
export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
export const PUBLISH_PERMISSION = "instagram_content_publish";

export const DEFAULT_ACCESS_TOKEN_SERVICE = "instagram-access-token";
export const DEFAULT_APP_SECRET_SERVICE = "meta-app-secret";
const ACCESS_TOKEN_CONFIG_KEY = "instagramAccessToken";
const APP_SECRET_CONFIG_KEY = "metaAppSecret";

export type GraphRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

/** Minimal fetch shape so tests can inject a fake Graph API. */
export type GraphFetch = (url: string, init?: GraphRequestInit) => Promise<Response>;

export type InstagramDeps = {
  homeDir?: string;
  keychainRunner?: KeychainRunner;
  graphFetch?: GraphFetch;
};

export type InstagramCommandResult = {
  exitCode: number;
  stdout: string[];
  stderr: string[];
};

export type ConnectInput = {
  igUserId?: string;
  appId?: string;
  tokenFromStdin?: string;
  appSecretFromStdin?: string;
};

type InstagramConfig = {
  igUserId?: string;
  username?: string;
  appId?: string;
  accessTokenKeychainService?: string;
  appSecretKeychainService?: string;
};

/** Thrown internally to stop a command with a short, actionable message. */
class InstagramStop extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    /** Lines already produced before stopping (e.g. partial status). */
    readonly stdout: string[] = []
  ) {
    super(message);
  }
}

export async function connectInstagram(
  input: ConnectInput,
  deps: InstagramDeps
): Promise<InstagramCommandResult> {
  const secrets: string[] = [];
  return guard(secrets, async () => {
    const stdout: string[] = [];
    const config = await requireConfig(deps.homeDir);
    const current = selectInstagramConfig(config);

    if (input.tokenFromStdin !== undefined) {
      const token = requireStdinValue(input.tokenFromStdin, "토큰");
      secrets.push(token);
      await writeConfigSecret(ACCESS_TOKEN_CONFIG_KEY, token, deps);
      stdout.push("액세스 토큰을 config(0600)에 저장했습니다.");
    }
    if (input.appSecretFromStdin !== undefined) {
      const secret = requireStdinValue(input.appSecretFromStdin, "앱 시크릿");
      secrets.push(secret);
      await writeConfigSecret(APP_SECRET_CONFIG_KEY, secret, deps);
      stdout.push("앱 시크릿을 config(0600)에 저장했습니다.");
    }

    const igUserId = input.igUserId ?? current.igUserId;
    if (!igUserId) {
      throw new InstagramStop(
        "Usage: uncommitted instagram connect --ig-user-id <ID> [--app-id <ID>] [--token-from-stdin | --app-secret-from-stdin]",
        1
      );
    }
    if (!/^\d+$/.test(igUserId)) {
      throw new InstagramStop("--ig-user-id는 숫자 ID여야 합니다.", 1);
    }

    const token = await requireSecret(tokenSpec(current), "access-token", deps);
    secrets.push(token.value);

    const account = await graphGet(
      deps,
      `/${igUserId}`,
      { fields: "id,username", access_token: token.value },
      "account"
    );
    const username = typeof account.username === "string" ? account.username : "";
    if (username === "") {
      throw new InstagramStop(
        "Instagram 계정의 handle을 읽지 못했습니다. IG 사용자 ID가 맞는지 확인하세요.",
        2
      );
    }

    let appId = input.appId ?? current.appId;
    if (!appId) {
      const app = await graphGet(deps, "/app", { fields: "id", access_token: token.value }, "app");
      appId = typeof app.id === "string" ? app.id : undefined;
    }
    if (!appId) {
      throw new InstagramStop(
        "Meta 앱 ID를 확인하지 못했습니다. --app-id <앱 ID>를 함께 넘기세요.",
        2
      );
    }

    const appSecret = await readSecret(appSecretSpec(current), deps);
    let permissionLine: string;
    if (appSecret.found) {
      secrets.push(appSecret.value);
      const debug = await debugToken(deps, token.value, appId, appSecret.value);
      assertTokenUsable(debug);
      permissionLine = `게시 권한: 있음 (${PUBLISH_PERMISSION})`;
    } else {
      permissionLine =
        "게시 권한: 확인 안 함 (앱 시크릿 없음 — `uncommitted instagram status` 전에 저장하세요)";
    }

    await updateGlobalConfig(deps.homeDir, (latest) => ({
      ...latest,
      instagram: {
        // Spread the raw object so sibling settings (e.g. `hosting`) survive.
        ...(isRecord(latest.instagram) ? latest.instagram : {}),
        igUserId,
        username,
        appId
      }
    }));

    stdout.push(`연결됨: @${username}`, `IG 사용자 ID: ${igUserId}`, permissionLine);
    return { exitCode: 0, stdout, stderr: [] };
  });
}

export async function instagramStatus(
  deps: InstagramDeps
): Promise<InstagramCommandResult> {
  const secrets: string[] = [];
  return guard(secrets, async () => {
    const config = await loadConfigRecord(deps.homeDir);
    const current = selectInstagramConfig(config ?? {});
    if (!current.igUserId) {
      return { exitCode: 0, stdout: ["Instagram: 연결 안 됨"], stderr: [] };
    }

    const stdout = [
      `Instagram: 연결됨 @${current.username ?? "(알 수 없음)"}`,
      `IG 사용자 ID: ${current.igUserId}`
    ];

    const token = await requireSecret(tokenSpec(current), "access-token", deps, stdout);
    secrets.push(token.value);
    stdout.push(`액세스 토큰 출처: ${token.source}`);

    const appSecret = await requireSecret(appSecretSpec(current), "app-secret", deps, stdout);
    secrets.push(appSecret.value);
    stdout.push(`앱 시크릿 출처: ${appSecret.source}`);

    if (!current.appId) {
      throw new InstagramStop(
        "Meta 앱 ID가 config에 없습니다. `uncommitted instagram connect --app-id <앱 ID>`로 다시 연결하세요.",
        2,
        stdout
      );
    }

    const debug = await debugToken(deps, token.value, current.appId, appSecret.value).catch(
      (error: unknown) => {
        throw withStdout(error, stdout);
      }
    );
    if (debug.isValid) {
      stdout.push(
        `토큰 상태: ${debug.expiresAt === 0 ? "유효 (만료 없음)" : `유효 (만료: ${new Date(debug.expiresAt * 1000).toISOString()})`}`
      );
    } else {
      stdout.push("토큰 상태: 무효");
    }
    if (debug.isValid) {
      stdout.push(`게시 권한: ${debug.scopes.includes(PUBLISH_PERMISSION) ? "있음" : "없음"}`);
    }

    try {
      assertTokenUsable(debug);
    } catch (error) {
      throw withStdout(error, stdout);
    }
    return { exitCode: 0, stdout, stderr: [] };
  });
}

export async function disconnectInstagram(
  deps: InstagramDeps
): Promise<InstagramCommandResult> {
  return guard([], async () => {
    const config = await loadConfigRecord(deps.homeDir);
    const current = selectInstagramConfig(config ?? {});

    const removedSecrets = config
      ? await removeConfigSecrets([ACCESS_TOKEN_CONFIG_KEY, APP_SECRET_CONFIG_KEY], deps)
      : [];

    if (config && isRecord(config.instagram)) {
      await updateGlobalConfig(deps.homeDir, (latest) => {
        const next = { ...latest };
        const remaining = isRecord(latest.instagram) ? { ...latest.instagram } : {};
        delete remaining.igUserId;
        delete remaining.username;
        delete remaining.appId;
        if (Object.keys(remaining).length === 0) {
          delete next.instagram;
        } else {
          next.instagram = remaining;
        }
        return next;
      });
    }

    const tokenService = tokenSpec(current).keychainService;
    const secretService = appSecretSpec(current).keychainService;
    return {
      exitCode: 0,
      stdout: [
        "Instagram 연결을 해제했습니다.",
        removedSecrets.length > 0
          ? "config에 저장된 비밀값을 지웠습니다."
          : "config에 저장된 비밀값은 없었습니다.",
        "키체인 항목은 그대로 둡니다. 지우려면:",
        `  security delete-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${tokenService}`,
        `  security delete-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${secretService}`
      ],
      stderr: []
    };
  });
}

export type PublishAccount =
  | { ok: true; igUserId: string; accessToken: string }
  | { ok: false; message: string; exitCode: number };

/**
 * UNC-296: the connected IG user ID and its access token for publishing.
 * Same lookup as `instagram status` (keychain → config secret); never logs.
 */
export async function resolvePublishAccount(deps: InstagramDeps): Promise<PublishAccount> {
  const config = await loadConfigRecord(deps.homeDir);
  const current = selectInstagramConfig(config ?? {});
  if (!current.igUserId) {
    return {
      ok: false,
      message:
        "Instagram 계정이 연결되지 않았습니다. `uncommitted instagram connect --ig-user-id <ID>`를 먼저 실행하세요.",
      exitCode: 2
    };
  }
  try {
    const token = await requireSecret(tokenSpec(current), "access-token", deps);
    return { ok: true, igUserId: current.igUserId, accessToken: token.value };
  } catch (error) {
    if (error instanceof InstagramStop) {
      return { ok: false, message: error.message, exitCode: error.exitCode };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type DebugTokenResult = { isValid: boolean; expiresAt: number; scopes: string[] };

async function debugToken(
  deps: InstagramDeps,
  token: string,
  appId: string,
  appSecret: string
): Promise<DebugTokenResult> {
  // A System User token cannot inspect itself (#100); the app token can.
  const body = await graphGet(
    deps,
    "/debug_token",
    { input_token: token, access_token: `${appId}|${appSecret}` },
    "debug"
  );
  const data = isRecord(body.data) ? body.data : {};
  return {
    isValid: data.is_valid === true,
    expiresAt: typeof data.expires_at === "number" ? data.expires_at : 0,
    scopes: Array.isArray(data.scopes)
      ? data.scopes.filter((scope): scope is string => typeof scope === "string")
      : []
  };
}

function assertTokenUsable(debug: DebugTokenResult): void {
  if (!debug.isValid) {
    throw new InstagramStop(INVALID_TOKEN_MESSAGE, 2);
  }
  if (!debug.scopes.includes(PUBLISH_PERMISSION)) {
    throw new InstagramStop(
      `토큰에 ${PUBLISH_PERMISSION} 권한이 없습니다. Meta 비즈니스 설정에서 시스템 사용자 토큰을 ${PUBLISH_PERMISSION} 권한을 포함해 다시 발급한 뒤 저장하세요.`,
      2
    );
  }
}

const INVALID_TOKEN_MESSAGE =
  "액세스 토큰이 무효이거나 취소됐습니다. Meta 비즈니스 설정에서 시스템 사용자 토큰을 다시 발급해 저장한 뒤 `uncommitted instagram connect`를 다시 실행하세요.";

type GraphCall = "account" | "app" | "debug";

async function graphGet(
  deps: InstagramDeps,
  path: string,
  params: Record<string, string>,
  call: GraphCall
): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const fetchImpl: GraphFetch = deps.graphFetch ?? ((target) => fetch(target));
  let response: Response;
  let body: unknown;
  try {
    response = await fetchImpl(url.toString());
    body = await response.json().catch(() => ({}));
  } catch {
    // Never surface the underlying error: it may carry the request URL.
    throw new InstagramStop(
      "Meta Graph API에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.",
      1
    );
  }

  const record = isRecord(body) ? body : {};
  if (response.ok && !isRecord(record.error)) {
    return record;
  }

  const error = isRecord(record.error) ? record.error : {};
  const code = typeof error.code === "number" ? error.code : undefined;
  throw new InstagramStop(graphErrorMessage(call, code), code === undefined ? 1 : 2);
}

function graphErrorMessage(call: GraphCall, code: number | undefined): string {
  if (call === "debug") {
    return "토큰을 검사하지 못했습니다. 앱 시크릿과 앱 ID가 같은 Meta 앱의 값인지 확인하세요.";
  }
  if (code === 190 || code === 102) {
    return INVALID_TOKEN_MESSAGE;
  }
  if (call === "app") {
    return "Meta 앱 ID를 확인하지 못했습니다. --app-id <앱 ID>를 함께 넘기세요.";
  }
  if (code === 10 || code === 200 || (code !== undefined && code >= 200 && code < 300)) {
    return `토큰에 이 Instagram 계정 권한이 없습니다. 시스템 사용자에 계정을 할당하고 instagram_basic, ${PUBLISH_PERMISSION} 권한으로 토큰을 다시 발급하세요.`;
  }
  if (code === 100) {
    return "Instagram 계정을 찾을 수 없습니다. IG 사용자 ID가 맞는지, 계정이 프로페셔널(비즈니스/크리에이터) 계정이고 비즈니스 포트폴리오에 연결돼 있는지 확인하세요.";
  }
  return `Instagram 계정 확인에 실패했습니다 (Graph API 에러 ${code ?? "알 수 없음"}). 잠시 뒤 다시 시도하세요.`;
}

async function requireConfig(homeDir: string | undefined): Promise<Record<string, unknown>> {
  const config = await loadConfigRecord(homeDir);
  if (!config) {
    throw new InstagramStop("Config not found or invalid. Run `uncommitted init` first.", 2);
  }
  return config;
}

async function requireSecret(
  spec: SecretSpec,
  kind: "access-token" | "app-secret",
  deps: InstagramDeps,
  stdout: string[] = []
) {
  const result = await readSecret(spec, deps);
  if (result.found) {
    return result;
  }
  throw new InstagramStop(
    formatMissingSecretMessage(
      kind === "access-token"
        ? {
            label: "Instagram 액세스 토큰",
            spec,
            configCommand:
              "pbpaste | uncommitted instagram connect --token-from-stdin --ig-user-id <ID>"
          }
        : {
            label: "Meta 앱 시크릿",
            spec,
            configCommand: "pbpaste | uncommitted instagram connect --app-secret-from-stdin"
          }
    ),
    2,
    stdout
  );
}

function requireStdinValue(raw: string, label: string): string {
  const value = raw.trim();
  if (value === "" || /\s/.test(value)) {
    throw new InstagramStop(`stdin에서 ${label} 값을 한 줄로 받지 못했습니다.`, 1);
  }
  return value;
}

function selectInstagramConfig(config: Record<string, unknown>): InstagramConfig {
  const raw = isRecord(config.instagram) ? config.instagram : {};
  const pick = (key: keyof InstagramConfig) =>
    typeof raw[key] === "string" && (raw[key] as string) !== "" ? (raw[key] as string) : undefined;
  return {
    igUserId: pick("igUserId"),
    username: pick("username"),
    appId: pick("appId"),
    accessTokenKeychainService: pick("accessTokenKeychainService"),
    appSecretKeychainService: pick("appSecretKeychainService")
  };
}

function tokenSpec(config: InstagramConfig): SecretSpec {
  return {
    keychainService: config.accessTokenKeychainService ?? DEFAULT_ACCESS_TOKEN_SERVICE,
    configKey: ACCESS_TOKEN_CONFIG_KEY
  };
}

function appSecretSpec(config: InstagramConfig): SecretSpec {
  return {
    keychainService: config.appSecretKeychainService ?? DEFAULT_APP_SECRET_SERVICE,
    configKey: APP_SECRET_CONFIG_KEY
  };
}

function withStdout(error: unknown, stdout: string[]): unknown {
  if (error instanceof InstagramStop && error.stdout.length === 0) {
    return new InstagramStop(error.message, error.exitCode, stdout);
  }
  return error;
}

/**
 * Run a command, converting {@link InstagramStop} into a result and scrubbing
 * every known secret value from all output as a last line of defense.
 */
async function guard(
  secrets: string[],
  body: () => Promise<InstagramCommandResult>
): Promise<InstagramCommandResult> {
  let result: InstagramCommandResult;
  try {
    result = await body();
  } catch (error) {
    if (!(error instanceof InstagramStop)) {
      throw error;
    }
    result = { exitCode: error.exitCode, stdout: error.stdout, stderr: [error.message] };
  }
  const scrub = (line: string) =>
    secrets.reduce(
      (text, secret) => (secret.length >= 8 ? text.split(secret).join("[redacted]") : text),
      line
    );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.map(scrub),
    stderr: result.stderr.map(scrub)
  };
}
