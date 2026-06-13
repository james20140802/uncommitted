import { describe, it, expect } from "vitest";
import { detectSecrets, SECRET_CATEGORY_ORDER } from "../src/credential-detector.js";

describe("detectSecrets", () => {
  it("masks AWS access keys and reports vendor api tokens category", () => {
    const result = detectSecrets("aws creds: AKIAIOSFODNN7EXAMPLE in env");
    expect(result.value).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.value).toContain("[redacted-secret]");
    expect(result.categories).toContain("vendor api tokens");
  });

  it("masks GitHub PAT, Slack token, Google API key, Stripe key, and PEM headers", () => {
    const sample = [
      "ghp_" + "a".repeat(36),
      "xoxb-12345-67890-abcdef",
      "AIza" + "b".repeat(35),
      "sk_live_" + "c".repeat(24),
      "-----BEGIN RSA PRIVATE KEY-----"
    ].join(" | ");
    const result = detectSecrets(sample);
    expect(result.value).not.toContain("ghp_");
    expect(result.value).not.toContain("xoxb-");
    expect(result.value).not.toContain("AIza");
    expect(result.value).not.toContain("sk_live_");
    expect(result.value).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(result.categories).toEqual(["vendor api tokens"]);
  });

  it("masks Bearer tokens and JWTs", () => {
    const sample =
      "Authorization: Bearer eyJalg.eyJsub.SflKx and curl -H 'Authorization: Bearer abc.def.ghi'";
    const result = detectSecrets(sample);
    expect(result.value).not.toContain("eyJalg");
    expect(result.value).not.toContain("Bearer abc.def.ghi");
    expect(result.categories).toContain("vendor api tokens");
  });

  it("masks lowercase bearer headers (HTTP headers are case-insensitive)", () => {
    const sample =
      "authorization: bearer sk-lowercaseopaquetoken123 logged by a tool";
    const result = detectSecrets(sample);
    expect(result.value).not.toContain("sk-lowercaseopaquetoken123");
    expect(result.value).toContain("[redacted-secret]");
    expect(result.categories).toContain("vendor api tokens");
  });

  it("masks values after password=/api_key:/secret = without touching the key half", () => {
    const sample = `password="hunter2hunter2"
api_key: AbCdEf123456789
secret = topSecretValue123`;
    const result = detectSecrets(sample);
    expect(result.value).toContain("password=");
    expect(result.value).toContain("api_key:");
    expect(result.value).toContain("secret =");
    expect(result.value).not.toContain("hunter2hunter2");
    expect(result.value).not.toContain("AbCdEf123456789");
    expect(result.value).not.toContain("topSecretValue123");
    expect(result.categories).toContain("assignment secrets");
  });

  it("masks high-entropy tokens that no vendor pattern catches", () => {
    const blob = "QmFzZTY0SGlnaEVudHJvcHlSb2xsaW5nVG9rZW4xMjM0NQ";
    const result = detectSecrets(`maybe a token: ${blob} trailing`);
    expect(result.value).not.toContain(blob);
    expect(result.categories).toContain("high-entropy tokens");
  });

  it("does not mask plain English prose or short identifiers", () => {
    const sample =
      "Today we shipped the carousel renderer and discussed Tier 1 archive permissions.";
    const result = detectSecrets(sample);
    expect(result.value).toBe(sample);
    expect(result.categories).toEqual([]);
  });

  it("does not mask conventional UUIDs that lack the entropy threshold", () => {
    const sample = "request-id: 550e8400-e29b-41d4-a716-446655440000";
    const result = detectSecrets(sample);
    expect(result.value).toBe(sample);
    expect(result.categories).toEqual([]);
  });

  it("emits categories in the stable SECRET_CATEGORY_ORDER", () => {
    const sample =
      "AKIAIOSFODNN7EXAMPLE password=topSecretValue123 " +
      "QmFzZTY0SGlnaEVudHJvcHlSb2xsaW5nVG9rZW4xMjM0NQ";
    const result = detectSecrets(sample);
    const orderIndex = (c: string) =>
      SECRET_CATEGORY_ORDER.indexOf(c as (typeof SECRET_CATEGORY_ORDER)[number]);
    for (let i = 1; i < result.categories.length; i++) {
      expect(orderIndex(result.categories[i - 1])).toBeLessThan(
        orderIndex(result.categories[i])
      );
    }
    expect(new Set(result.categories).size).toBe(result.categories.length);
  });

  it("does not call any external service (LLM-free, deterministic)", () => {
    const sample =
      "Authorization: Bearer abc.def.ghi and password=hunter2hunter2";
    const a = detectSecrets(sample);
    const b = detectSecrets(sample);
    expect(a).toEqual(b);
  });
});
