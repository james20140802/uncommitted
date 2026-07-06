import { describe, expect, it } from "vitest";
import { emailPattern, sanitizeText } from "../src/redaction.js";

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

  it("uses an unambiguous, non-backtracking pattern source", () => {
    const source = emailPattern().source;
    // Domain labels are dot-terminated, so the class never overlaps the naive
    // `[A-Z0-9.-]+\.[A-Z]` form CodeQL flags as polynomial-ReDoS.
    expect(source).not.toContain("[A-Z0-9.-]");
    expect(source).toContain("(?:[A-Z0-9-]+\\.)+");
    // Anchored at the token start so an over-length local part cannot be
    // matched from its interior, leaving a leading fragment behind.
    expect(source.startsWith("(?<![A-Z0-9._%+-])")).toBe(true);
  });
});

describe("sanitizeText email redaction", () => {
  it("redacts an ordinary email fully", () => {
    const r = sanitizeText("ping me@example.com please");
    expect(r.value).toBe("ping [redacted-email] please");
    expect(r.categories).toContain("emails");
  });

  it("does not leak the leading characters of an over-length local part", () => {
    const email = `${"a".repeat(80)}@example.com`;
    const r = sanitizeText(`contact ${email} now`);
    // The whole address must be gone — no run of the local part may survive.
    expect(r.value).not.toMatch(/a{2,}/);
    expect(r.value).not.toContain("@example.com");
    expect(r.value).toBe("contact [redacted-email] now");
    expect(r.categories).toContain("emails");
  });

  it("redacts an email whose domain label exceeds the old 255 bound", () => {
    const email = `user@${"d".repeat(300)}.com`;
    const r = sanitizeText(`from ${email} sent`);
    expect(r.value).not.toContain("@");
    expect(r.value).not.toMatch(/d{2,}/);
    expect(r.value).toBe("from [redacted-email] sent");
    expect(r.categories).toContain("emails");
  });

  it("redacts multi-label domains", () => {
    const r = sanitizeText("reply to a.b@sub.example.co.uk today");
    expect(r.value).toBe("reply to [redacted-email] today");
  });

  it("stays linear on adversarial non-matching input (no ReDoS)", () => {
    const evil = `x@${".a".repeat(40000)}!`;
    const start = Date.now();
    sanitizeText(evil);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
