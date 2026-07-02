import { describe, expect, it } from "vitest";
import {
  BILLING_429_MESSAGE,
  classify429ResponseBody
} from "../src/provider-429-classifier.js";

describe("429 billing-vs-rate-limit classifier", () => {
  it("classifies insufficient_quota (error.type) as billing", () => {
    expect(
      classify429ResponseBody({ error: { type: "insufficient_quota" } })
    ).toBe("billing");
  });

  it("classifies billing_hard_limit_reached (error.type) as billing", () => {
    expect(
      classify429ResponseBody({ error: { type: "billing_hard_limit_reached" } })
    ).toBe("billing");
  });

  it("classifies a billing key surfaced via error.code as billing", () => {
    expect(
      classify429ResponseBody({
        error: { type: "some_other_type", code: "insufficient_quota" }
      })
    ).toBe("billing");
  });

  it("classifies a plain rate-limit body as generic", () => {
    expect(
      classify429ResponseBody({
        error: { type: "rate_limit_exceeded", code: "rate_limit_exceeded" }
      })
    ).toBe("generic");
  });

  it("falls back to generic on a null / non-object / missing-error body", () => {
    expect(classify429ResponseBody(null)).toBe("generic");
    expect(classify429ResponseBody(undefined)).toBe("generic");
    expect(classify429ResponseBody("not json")).toBe("generic");
    expect(classify429ResponseBody(42)).toBe("generic");
    expect(classify429ResponseBody({})).toBe("generic");
    expect(classify429ResponseBody({ error: null })).toBe("generic");
    expect(classify429ResponseBody({ error: { type: 123 } })).toBe("generic");
  });

  it("exposes a billing message that names a credit/billing cause and does not imply retry", () => {
    expect(BILLING_429_MESSAGE.toLowerCase()).toContain("billing");
    expect(BILLING_429_MESSAGE.toLowerCase()).not.toContain("try again later");
  });
});
