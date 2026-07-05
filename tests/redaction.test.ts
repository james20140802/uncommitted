import { describe, expect, it } from "vitest";
import { emailPattern } from "../src/redaction.js";

describe("emailPattern", () => {
  it("is a function exported from src/redaction.js", () => {
    expect(typeof emailPattern).toBe("function");
  });

  it("defaults to the gi flags", () => {
    expect(emailPattern().flags).toBe("gi");
  });

  it("returns a fresh RegExp instance on every call", () => {
    expect(emailPattern("gi")).not.toBe(emailPattern("gi"));
  });

  it("honors requested flags", () => {
    const pattern = emailPattern("i");
    expect(pattern.global).toBe(false);
    expect(pattern.ignoreCase).toBe(true);
  });

  it("matches representative real emails", () => {
    expect(emailPattern("i").test("foo.bar+baz@sub.example.co.uk")).toBe(true);
    expect(emailPattern("i").test("a@b.co")).toBe(true);
    expect(emailPattern("i").test("USER_NAME@Example.COM")).toBe(true);
  });

  it("does not match non-email text", () => {
    expect(emailPattern("i").test("not-an-email")).toBe(false);
    expect(emailPattern("i").test("@nodomain")).toBe(false);
  });

  it("uses a bounded pattern source (no unbounded +/{2,} email quantifiers)", () => {
    const source = emailPattern().source;
    expect(source).toContain("{1,64}");
    expect(source).toContain("{1,255}");
    expect(source).toContain("{2,24}");
  });
});
