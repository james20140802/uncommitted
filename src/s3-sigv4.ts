import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature Version 4 for S3-compatible storage (UNC-295).
 *
 * Covers exactly what temporary image hosting needs: header-signed PUT/DELETE
 * and query-presigned GET. Verified against the official AWS S3 SigV4
 * examples in tests/s3-sigv4.test.ts. Hand-rolled instead of pulling in
 * `@aws-sdk/client-s3` (a large dependency tree) for three requests.
 */

export type S3Credentials = { accessKeyId: string; secretAccessKey: string };

type SignInput = {
  method: string;
  url: string;
  region: string;
  credentials: S3Credentials;
  now: Date;
};

const ALGORITHM = "AWS4-HMAC-SHA256";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Returns `url` with SigV4 query authentication (`X-Amz-*`) appended. */
export function presignS3Url(input: SignInput & { expiresSeconds: number }): string {
  const url = new URL(input.url);
  const { amzDate, scope } = timeScope(input.now, input.region);

  url.searchParams.set("X-Amz-Algorithm", ALGORITHM);
  url.searchParams.set("X-Amz-Credential", `${input.credentials.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(input.expiresSeconds));
  url.searchParams.set("X-Amz-SignedHeaders", "host");

  const signature = sign(input, url, { host: url.host }, UNSIGNED_PAYLOAD);
  url.searchParams.set("X-Amz-Signature", signature);
  return `${url.origin}${canonicalPath(url)}?${canonicalQuery(url)}`;
}

/**
 * Returns the headers to send (lower-case names): the given `headers` plus
 * `x-amz-date`, `x-amz-content-sha256` and `authorization`. `host` is signed
 * but left for the HTTP client to send.
 */
export function signS3Request(
  input: SignInput & { headers?: Record<string, string>; payloadHash: string }
): Record<string, string> {
  const url = new URL(input.url);
  const { amzDate, scope } = timeScope(input.now, input.region);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  headers["x-amz-content-sha256"] = input.payloadHash;
  headers["x-amz-date"] = amzDate;

  const signed = { ...headers, host: url.host };
  const signature = sign(input, url, signed, input.payloadHash);
  headers.authorization =
    `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope},` +
    `SignedHeaders=${Object.keys(signed).sort().join(";")},Signature=${signature}`;
  return headers;
}

function sign(
  input: SignInput,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string
): string {
  const { amzDate, dateStamp, scope } = timeScope(input.now, input.region);
  const names = Object.keys(headers).sort();
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url),
    canonicalQuery(url),
    names.map((name) => `${name}:${headers[name].trim()}\n`).join(""),
    names.join(";"),
    payloadHash
  ].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  let key: Buffer = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  for (const part of [input.region, "s3", "aws4_request"]) {
    key = hmac(key, part);
  }
  return hmac(key, stringToSign).toString("hex");
}

function timeScope(now: Date, region: string) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp, scope: `${dateStamp}/${region}/s3/aws4_request` };
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding as SigV4 requires (`encodeURIComponent` leaves !'()*). */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalPath(url: URL): string {
  return url.pathname
    .split("/")
    .map((segment) => rfc3986(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}
