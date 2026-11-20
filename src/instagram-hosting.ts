import { randomBytes } from "node:crypto";
import sharp from "sharp";
import {
  formatMissingSecretMessage,
  type KeychainRunner,
  loadConfigRecord,
  readSecret,
  type SecretSpec,
  updateGlobalConfig,
  writeConfigSecret
} from "./keychain-store.js";
import { presignS3Url, type S3Credentials, sha256Hex, signS3Request } from "./s3-sigv4.js";
import { isRecord } from "./type-guards.js";

/**
 * Temporary public image hosting for Instagram publishing (UNC-295).
 *
 * The Graph API only accepts public image URLs, so a publish uploads each
 * image, hands the URL to Meta, and deletes the object afterwards — success
 * or failure. Publishing code depends only on {@link ImageHost}; the first
 * implementation is S3-compatible storage (Cloudflare R2, AWS S3, ...).
 */

export type HostingFile = { bytes: Uint8Array; contentType: string };
export type HostedImage = { url: string; cleanup(): Promise<void> };
export type ImageHost = { upload(file: HostingFile): Promise<HostedImage> };

/** Minimal fetch shape so tests can inject fake storage. */
export type HostingFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array }
) => Promise<Response>;

export type HostingDeps = {
  homeDir?: string;
  keychainRunner?: KeychainRunner;
  hostingFetch?: HostingFetch;
  now?: () => Date;
};

export type HostingCommandResult = { exitCode: number; stdout: string[]; stderr: string[] };

export const HOSTING_NOT_CONFIGURED_MESSAGE =
  "이미지 호스팅이 설정되지 않았습니다. `uncommitted instagram host set`을 실행하세요.";

/** Presigned GET lifetime. Meta fetches at container creation (+ ~5 min polling). */
export const PRESIGNED_URL_TTL_SECONDS = 3600;

export const DEFAULT_ACCESS_KEY_ID_SERVICE = "r2-access-key-id";
export const DEFAULT_SECRET_ACCESS_KEY_SERVICE = "r2-secret-access-key";
const ACCESS_KEY_ID_CONFIG_KEY = "hostingAccessKeyId";
const SECRET_ACCESS_KEY_CONFIG_KEY = "hostingSecretAccessKey";

/** Short, actionable failure carrying the CLI exit code (2 = config error). */
export class HostingError extends Error {
  constructor(
    message: string,
    readonly exitCode: number
  ) {
    super(message);
    this.name = "HostingError";
  }
}

export type S3HostingConfig = {
  provider: "s3";
  endpoint: string;
  bucket: string;
  region: string;
  publicBaseUrl?: string;
  accessKeyIdKeychainService?: string;
  secretAccessKeyKeychainService?: string;
};

// ---------------------------------------------------------------------------
// Publish-flow helper
// ---------------------------------------------------------------------------

/**
 * Upload `files`, run `publish` with their URLs, and always clean up every
 * uploaded object. Cleanup failures only warn; they never change the publish
 * outcome (its result or its error).
 */
export async function withHostedImages<T>(
  host: ImageHost,
  files: HostingFile[],
  publish: (urls: string[]) => Promise<T>,
  options: { onWarning?: (message: string) => void } = {}
): Promise<T> {
  const hosted: HostedImage[] = [];
  try {
    for (const file of files) {
      hosted.push(await host.upload(file));
    }
    return await publish(hosted.map((image) => image.url));
  } finally {
    const results = await Promise.allSettled(hosted.map((image) => image.cleanup()));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed > 0) {
      options.onWarning?.(
        `임시 이미지 ${failed}개를 정리하지 못했습니다. 버킷 수명 주기 규칙이 나중에 지웁니다.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// S3-compatible host
// ---------------------------------------------------------------------------

/** Build the configured host, or throw {@link HostingError} (exit 2) when unset. */
export async function resolveImageHost(deps: HostingDeps): Promise<ImageHost> {
  const config = await readHostingConfig(deps.homeDir);
  if (!config) {
    throw new HostingError(HOSTING_NOT_CONFIGURED_MESSAGE, 2);
  }
  const credentials = await requireCredentials(config, deps);
  return createS3ImageHost(config, credentials, deps);
}

export function createS3ImageHost(
  config: S3HostingConfig,
  credentials: S3Credentials,
  deps: Pick<HostingDeps, "hostingFetch" | "now"> = {}
): ImageHost {
  const fetchImpl = deps.hostingFetch ?? defaultFetch;
  const now = deps.now ?? (() => new Date());
  let sequence = 0;

  const objectUrl = (key: string) => `${config.endpoint}/${config.bucket}/${key}`;
  const signed = (method: string, key: string, body?: Uint8Array, contentType?: string) => {
    const payloadHash = sha256Hex(body ?? new Uint8Array());
    const headers = signS3Request({
      method,
      url: objectUrl(key),
      region: config.region,
      credentials,
      now: now(),
      payloadHash,
      headers: contentType ? { "content-type": contentType } : {}
    });
    return storageRequest(fetchImpl, objectUrl(key), { method, headers, body });
  };

  return {
    async upload(file) {
      sequence += 1;
      // Random, unguessable, and free of dates, project names, paths or users.
      const key = `uncommitted/${randomBytes(16).toString("hex")}/${String(sequence).padStart(2, "0")}.${extensionFor(file.contentType)}`;
      const put = await signed("PUT", key, file.bytes, file.contentType);
      if (!put.ok) {
        throw new HostingError(storageFailure("업로드", put.status), 1);
      }

      const url = config.publicBaseUrl
        ? `${config.publicBaseUrl}/${key}`
        : presignS3Url({
            method: "GET",
            url: objectUrl(key),
            region: config.region,
            credentials,
            now: now(),
            expiresSeconds: PRESIGNED_URL_TTL_SECONDS
          });

      let cleaned = false;
      return {
        url,
        async cleanup() {
          if (cleaned) return;
          const response = await signed("DELETE", key);
          if (!response.ok && response.status !== 404) {
            throw new HostingError(storageFailure("삭제", response.status), 1);
          }
          cleaned = true;
        }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Commands: instagram host set | status | test
// ---------------------------------------------------------------------------

export type HostSetInput = {
  endpoint?: string;
  bucket?: string;
  region?: string;
  publicBaseUrl?: string;
  accessKeyIdKeychainService?: string;
  secretAccessKeyKeychainService?: string;
  /** Raw stdin: line 1 access key ID, line 2 secret access key. */
  keysFromStdin?: string;
};

export async function setImageHosting(
  input: HostSetInput,
  deps: HostingDeps
): Promise<HostingCommandResult> {
  const secrets: string[] = [];
  return guard(secrets, async () => {
    const config = await loadConfigRecord(deps.homeDir);
    if (!config) {
      throw new HostingError("Config not found or invalid. Run `uncommitted init` first.", 2);
    }
    const current = selectHostingConfig(config);

    const endpoint = input.endpoint !== undefined ? normalizeBaseUrl(input.endpoint, "--endpoint") : current?.endpoint;
    const bucket = input.bucket ?? current?.bucket;
    if (!endpoint || !bucket) {
      throw new HostingError(HOST_SET_USAGE, 1);
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) {
      throw new HostingError("--bucket은 S3 버킷 이름(소문자, 숫자, '-', '.')이어야 합니다.", 1);
    }
    const publicBaseUrl =
      input.publicBaseUrl !== undefined
        ? normalizeBaseUrl(input.publicBaseUrl, "--public-base-url")
        : current?.publicBaseUrl;

    const stdout: string[] = [];
    if (input.keysFromStdin !== undefined) {
      const [accessKeyId, secretAccessKey] = parseStdinKeys(input.keysFromStdin);
      secrets.push(accessKeyId, secretAccessKey);
      await writeConfigSecret(ACCESS_KEY_ID_CONFIG_KEY, accessKeyId, deps);
      await writeConfigSecret(SECRET_ACCESS_KEY_CONFIG_KEY, secretAccessKey, deps);
      stdout.push("access key와 secret key를 config(0600)에 저장했습니다.");
    }

    const next: S3HostingConfig = {
      provider: "s3",
      endpoint,
      bucket,
      region: input.region ?? current?.region ?? "auto"
    };
    if (publicBaseUrl) next.publicBaseUrl = publicBaseUrl;
    const akService = input.accessKeyIdKeychainService ?? current?.accessKeyIdKeychainService;
    const skService =
      input.secretAccessKeyKeychainService ?? current?.secretAccessKeyKeychainService;
    if (akService) next.accessKeyIdKeychainService = akService;
    if (skService) next.secretAccessKeyKeychainService = skService;

    await updateGlobalConfig(deps.homeDir, (latest) => {
      const instagram = isRecord(latest.instagram) ? latest.instagram : {};
      return { ...latest, instagram: { ...instagram, hosting: next } };
    });

    stdout.push(
      "이미지 호스팅 설정을 저장했습니다.",
      `bucket: ${bucket}`,
      `URL 방식: ${urlModeLabel(next)}`,
      "확인: uncommitted instagram host test"
    );
    return { exitCode: 0, stdout, stderr: [] };
  });
}

export async function imageHostingStatus(deps: HostingDeps): Promise<HostingCommandResult> {
  return guard([], async () => {
    const config = await readHostingConfig(deps.homeDir);
    if (!config) {
      return { exitCode: 0, stdout: ["이미지 호스팅: 설정 안 됨"], stderr: [] };
    }
    const stdout = [
      "이미지 호스팅: S3 호환",
      `endpoint: ${new URL(config.endpoint).host}`,
      `bucket: ${config.bucket}`,
      `region: ${config.region}`,
      `URL 방식: ${urlModeLabel(config)}`
    ];
    const [accessKey, secretKey] = await Promise.all([
      readSecret(accessKeySpec(config), deps),
      readSecret(secretKeySpec(config), deps)
    ]);
    stdout.push(`access key 출처: ${accessKey.found ? accessKey.source : "없음"}`);
    stdout.push(`secret key 출처: ${secretKey.found ? secretKey.source : "없음"}`);
    if (!accessKey.found || !secretKey.found) {
      return {
        exitCode: 2,
        stdout,
        stderr: [missingKeysMessage(config, !accessKey.found ? "access" : "secret")]
      };
    }
    return { exitCode: 0, stdout, stderr: [] };
  });
}

/**
 * Upload a tiny JPEG, fetch it anonymously (expect 200), delete it, and
 * confirm it is gone. Prints a single success or failure line.
 */
export async function testImageHosting(deps: HostingDeps): Promise<HostingCommandResult> {
  const secrets: string[] = [];
  return guard(secrets, async () => {
    const config = await readHostingConfig(deps.homeDir);
    if (!config) {
      throw new HostingError(HOSTING_NOT_CONFIGURED_MESSAGE, 2);
    }
    const credentials = await requireCredentials(config, deps);
    secrets.push(credentials.accessKeyId, credentials.secretAccessKey);
    const host = createS3ImageHost(config, credentials, deps);
    const fetchImpl = deps.hostingFetch ?? defaultFetch;

    const fail = (step: string, detail: string) =>
      new HostingError(`호스팅 실패: ${step} — ${detail}`, 1);

    let hosted: HostedImage;
    try {
      hosted = await host.upload({ bytes: await testJpeg(), contentType: "image/jpeg" });
    } catch (error) {
      throw fail("업로드", errorDetail(error));
    }

    try {
      const get = await storageRequest(fetchImpl, hosted.url, { method: "GET" });
      if (get.status !== 200) {
        throw fail(
          "익명 GET",
          `HTTP ${get.status}. ${config.publicBaseUrl ? "공개 base URL과 버킷 공개 설정을" : "presigned URL이 막히지 않았는지"} 확인하세요.`
        );
      }
      try {
        await hosted.cleanup();
      } catch (error) {
        throw fail("삭제", errorDetail(error));
      }
      const after = await storageRequest(fetchImpl, hosted.url, { method: "GET" });
      if (after.status === 200) {
        throw fail("삭제 확인", "삭제한 뒤에도 이미지가 받아집니다. 캐시나 버킷 설정을 확인하세요.");
      }
    } catch (error) {
      await hosted.cleanup().catch(() => undefined);
      throw error instanceof HostingError && error.message.startsWith("호스팅 실패")
        ? error
        : fail("확인", errorDetail(error));
    }

    return { exitCode: 0, stdout: ["호스팅 OK"], stderr: [] };
  });
}

export const HOST_SET_USAGE =
  "Usage: uncommitted instagram host set --endpoint <https://...> --bucket <name> [--region auto] [--public-base-url <https://...>] [--access-key-service <name>] [--secret-key-service <name>] [--keys-from-stdin]";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function readHostingConfig(homeDir: string | undefined): Promise<S3HostingConfig | null> {
  const config = await loadConfigRecord(homeDir);
  return config ? selectHostingConfig(config) : null;
}

function selectHostingConfig(config: Record<string, unknown>): S3HostingConfig | null {
  const instagram = isRecord(config.instagram) ? config.instagram : {};
  const raw = isRecord(instagram.hosting) ? instagram.hosting : null;
  if (!raw) return null;
  const pick = (key: string) =>
    typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : undefined;
  const endpoint = pick("endpoint");
  const bucket = pick("bucket");
  if (!endpoint || !bucket) return null;
  return {
    provider: "s3",
    endpoint,
    bucket,
    region: pick("region") ?? "auto",
    publicBaseUrl: pick("publicBaseUrl"),
    accessKeyIdKeychainService: pick("accessKeyIdKeychainService"),
    secretAccessKeyKeychainService: pick("secretAccessKeyKeychainService")
  };
}

function accessKeySpec(config: S3HostingConfig): SecretSpec {
  return {
    keychainService: config.accessKeyIdKeychainService ?? DEFAULT_ACCESS_KEY_ID_SERVICE,
    configKey: ACCESS_KEY_ID_CONFIG_KEY
  };
}

function secretKeySpec(config: S3HostingConfig): SecretSpec {
  return {
    keychainService: config.secretAccessKeyKeychainService ?? DEFAULT_SECRET_ACCESS_KEY_SERVICE,
    configKey: SECRET_ACCESS_KEY_CONFIG_KEY
  };
}

async function requireCredentials(
  config: S3HostingConfig,
  deps: HostingDeps
): Promise<S3Credentials> {
  const accessKey = await readSecret(accessKeySpec(config), deps);
  if (!accessKey.found) {
    throw new HostingError(missingKeysMessage(config, "access"), 2);
  }
  const secretKey = await readSecret(secretKeySpec(config), deps);
  if (!secretKey.found) {
    throw new HostingError(missingKeysMessage(config, "secret"), 2);
  }
  return { accessKeyId: accessKey.value, secretAccessKey: secretKey.value };
}

function missingKeysMessage(config: S3HostingConfig, which: "access" | "secret"): string {
  return formatMissingSecretMessage({
    label: which === "access" ? "스토리지 access key ID" : "스토리지 secret access key",
    spec: which === "access" ? accessKeySpec(config) : secretKeySpec(config),
    configCommand:
      "printf '%s\\n%s\\n' <ACCESS_KEY_ID> <SECRET_ACCESS_KEY> | uncommitted instagram host set --keys-from-stdin"
  });
}

function urlModeLabel(config: Pick<S3HostingConfig, "publicBaseUrl">): string {
  return config.publicBaseUrl
    ? `공개 base URL (${new URL(config.publicBaseUrl).host})`
    : `presigned URL (${PRESIGNED_URL_TTL_SECONDS / 60}분 만료)`;
}

function normalizeBaseUrl(raw: string, flag: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HostingError(`${flag}는 https:// 로 시작하는 URL이어야 합니다.`, 1);
  }
  if (url.protocol !== "https:" || url.search || url.hash || url.username) {
    throw new HostingError(`${flag}는 https:// 로 시작하는 URL이어야 합니다.`, 1);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function parseStdinKeys(raw: string): [string, string] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length !== 2 || lines.some((line) => /\s/.test(line))) {
    throw new HostingError(
      "stdin에서 두 줄(1줄: access key ID, 2줄: secret access key)을 받지 못했습니다.",
      1
    );
  }
  return [lines[0], lines[1]];
}

function extensionFor(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  return "bin";
}

function storageFailure(step: string, status: number): string {
  if (status === 401 || status === 403) {
    return `스토리지 ${step} 권한이 없습니다 (HTTP ${status}). 키와 버킷 권한(객체 읽기/쓰기)을 확인하세요.`;
  }
  if (status === 404) {
    return `버킷을 찾지 못했습니다 (HTTP 404). endpoint와 bucket 이름을 확인하세요.`;
  }
  return `스토리지 ${step}에 실패했습니다 (HTTP ${status}).`;
}

async function storageRequest(
  fetchImpl: HostingFetch,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: Uint8Array }
): Promise<Response> {
  try {
    const response = await fetchImpl(url, init);
    // Drain the body so connections are released; never surface it (S3 error
    // XML can echo the access key ID).
    await response.arrayBuffer().catch(() => undefined);
    return response;
  } catch {
    // Never surface the underlying error: it may carry a presigned URL.
    throw new HostingError("스토리지에 연결하지 못했습니다. 네트워크와 endpoint를 확인하세요.", 1);
  }
}

const defaultFetch: HostingFetch = (url, init) =>
  fetch(url, init as RequestInit | undefined);

function errorDetail(error: unknown): string {
  return error instanceof HostingError ? error.message : "알 수 없는 오류";
}

async function testJpeg(): Promise<Uint8Array> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 255, b: 255 } }
  })
    .jpeg()
    .toBuffer();
}

/** Convert {@link HostingError} into a result and scrub known secrets from output. */
async function guard(
  secrets: string[],
  body: () => Promise<HostingCommandResult>
): Promise<HostingCommandResult> {
  let result: HostingCommandResult;
  try {
    result = await body();
  } catch (error) {
    if (!(error instanceof HostingError)) {
      throw error;
    }
    result = { exitCode: error.exitCode, stdout: [], stderr: [error.message] };
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
