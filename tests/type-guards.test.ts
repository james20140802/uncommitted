import { describe, expect, it } from "vitest";
import { isNodeError, isRecord } from "../src/type-guards.js";

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("excludes arrays", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  it("excludes null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("excludes primitives", () => {
    expect(isRecord(42)).toBe(false);
    expect(isRecord("config")).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("isNodeError", () => {
  it("returns true for an Error carrying a code", () => {
    const error = Object.assign(new Error("boom"), { code: "ENOENT" });
    expect(isNodeError(error)).toBe(true);
    if (isNodeError(error)) {
      expect(error.code).toBe("ENOENT");
    }
  });

  it("returns false for a plain Error without a code", () => {
    expect(isNodeError(new Error("boom"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isNodeError({ code: "ENOENT" })).toBe(false);
    expect(isNodeError("ENOENT")).toBe(false);
    expect(isNodeError(null)).toBe(false);
  });
});
