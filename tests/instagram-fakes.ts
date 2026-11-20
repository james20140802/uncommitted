import sharp from "sharp";
import type { CarouselHtmlToPngRenderer } from "../src/carousel-renderer.js";
import type { GraphFetch } from "../src/instagram-account.js";
import type { HostingFetch } from "../src/instagram-hosting.js";
import type { KeychainRunner } from "../src/keychain-store.js";

// Shared fakes for scheduled Instagram publishing tests (UNC-297). Nothing
// here touches the network: Graph API, S3 storage and the keychain are all
// in-memory stand-ins.

export const IG_USER_ID = "17841400000000000";
export const IG_TOKEN = "IGTOKEN-secret-value-0123456789abcdef";
export const IG_APP_SECRET = "app-secret-value-0123456789abcdef";
export const R2_ACCESS_KEY = "AKIDKEYCHAIN0123456789";
export const R2_SECRET_KEY = "keychain-secret-access-key-0123456789abcdef";
export const PERMALINK = "https://www.instagram.com/p/ABC123/";

export const INSTAGRAM_CONFIG = {
  igUserId: IG_USER_ID,
  username: "uncommitted.ai",
  appId: "123456",
  hosting: {
    provider: "s3",
    endpoint: "https://acct123.r2.cloudflarestorage.com",
    bucket: "uncommitted-publish",
    region: "auto"
  }
};

export function fakeKeychain(): { runner: KeychainRunner; calls: string[][] } {
  const entries: Record<string, string> = {
    "instagram-access-token": IG_TOKEN,
    "instagram-app-secret": IG_APP_SECRET,
    "r2-access-key-id": R2_ACCESS_KEY,
    "r2-secret-access-key": R2_SECRET_KEY
  };
  const calls: string[][] = [];
  const runner: KeychainRunner = async (args) => {
    calls.push(args);
    const service = args[args.indexOf("-s") + 1];
    const value = entries[service];
    return value === undefined
      ? { exitCode: 44, stdout: "" }
      : { exitCode: 0, stdout: `${value}\n` };
  };
  return { runner, calls };
}

export function fakeS3(): { fetch: HostingFetch; count: (method: string) => number } {
  const requests: { method: string }[] = [];
  const fetch: HostingFetch = async (_input, init = {}) => {
    const method = init.method ?? "GET";
    requests.push({ method });
    if (method === "PUT") return new Response("", { status: 200 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response("", { status: 404 });
  };
  return { fetch, count: (method) => requests.filter((r) => r.method === method).length };
}

export type FakeGraph = {
  fetch: GraphFetch;
  calls: { method: string; path: string }[];
  writes: () => { method: string; path: string }[];
};

/** A happy-path Graph API; `networkErrorOn` makes that POST path throw like a dropped connection. */
export function fakeGraph(options: { networkErrorOn?: "media" | "media_publish" } = {}): FakeGraph {
  const calls: { method: string; path: string }[] = [];
  let children = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch: GraphFetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
    calls.push({ method, path });
    const params = method === "GET" ? url.searchParams : new URLSearchParams(init.body ?? "");
    if (params.get("access_token") !== IG_TOKEN) {
      return json({ error: { message: "Invalid OAuth access token.", code: 190 } }, 400);
    }
    if (method === "GET" && path === `/${IG_USER_ID}/content_publishing_limit`) {
      return json({ data: [{ quota_usage: 1, config: { quota_total: 100 } }] });
    }
    if (method === "POST" && path === `/${IG_USER_ID}/media`) {
      if (options.networkErrorOn === "media") throw new TypeError("fetch failed");
      if (params.get("media_type") === "CAROUSEL") return json({ id: "carousel-1" });
      children += 1;
      return json({ id: `child-${children}` });
    }
    if (method === "POST" && path === `/${IG_USER_ID}/media_publish`) {
      if (options.networkErrorOn === "media_publish") throw new TypeError("fetch failed");
      return json({ id: "media-1" });
    }
    if (method === "GET" && path === "/media-1") {
      return json({ id: "media-1", permalink: PERMALINK });
    }
    if (method === "GET" && /^\/(child-\d+|carousel-1)$/.test(path)) {
      return json({ id: path.slice(1), status_code: "FINISHED" });
    }
    return json({ error: { message: `unexpected ${method} ${path}`, code: 100 } }, 400);
  };

  return { fetch, calls, writes: () => calls.filter((call) => call.method === "POST") };
}

export async function instagramPng(): Promise<Buffer> {
  return sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#123456" } })
    .png()
    .toBuffer();
}

/** Renders every slide as a valid 1080x1350 PNG so the Instagram media check passes. */
export class InstagramSizedPngRenderer implements CarouselHtmlToPngRenderer {
  calls = 0;

  async renderHtmlToPng(): Promise<Uint8Array> {
    this.calls += 1;
    return instagramPng();
  }
}
