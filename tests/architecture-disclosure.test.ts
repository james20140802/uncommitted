import { describe, expect, it } from "vitest";
import {
  detectArchitectureDisclosure,
  redactArchitectureDisclosure,
  ARCHITECTURE_DISCLOSURE_REPLACEMENT
} from "../src/architecture-disclosure.js";

describe("detectArchitectureDisclosure", () => {
  it("flags route-guard / admin-allowlist disclosure", () => {
    const text =
      "Hardened the route guard so only allowlisted admins hit the server-side authorization check.";
    const matches = detectArchitectureDisclosure(text);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.reason === "architecture-disclosure")).toBe(true);
  });

  it("flags admin allowlist disclosure", () => {
    const matches = detectArchitectureDisclosure(
      "Updated the admin allowlist so isAdmin gate lists include the new teammate."
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.reason === "architecture-disclosure")).toBe(true);
  });

  it("flags route-guard behavior disclosure", () => {
    const matches = detectArchitectureDisclosure(
      "Fixed the routeGuard beforeEnter auth redirect so canActivate rejects stale sessions."
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.reason === "architecture-disclosure")).toBe(true);
  });

  it("flags auth checkpoint disclosure", () => {
    const matches = detectArchitectureDisclosure(
      "Added an auth checkpoint via requireAuth middleware so ensureAuthenticated runs first."
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.reason === "architecture-disclosure")).toBe(true);
  });

  it("flags server-side authorization logic disclosure", () => {
    const matches = detectArchitectureDisclosure(
      "Rewrote the RBAC rule so the permission check enforces server-side authorization for exports."
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.reason === "architecture-disclosure")).toBe(true);
  });

  it("does not fire on benign admin-dashboard styling copy", () => {
    expect(detectArchitectureDisclosure("Polished the admin dashboard styling.")).toEqual([]);
  });

  it("does not fire on generic non-access-control edits", () => {
    expect(detectArchitectureDisclosure("Fixed a typo and renamed a variable.")).toEqual([]);
  });

  it("does not fire on the bare word admin alone", () => {
    expect(detectArchitectureDisclosure("Talked to the admin about the release schedule.")).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(detectArchitectureDisclosure("")).toEqual([]);
  });

  it("redacts matched spans and counts them", () => {
    const result = redactArchitectureDisclosure("Added an auth checkpoint via requireAuth middleware.");
    expect(result.count).toBeGreaterThan(0);
    expect(result.value).toContain(ARCHITECTURE_DISCLOSURE_REPLACEMENT);
    expect(result.value).not.toMatch(/requireAuth/);
  });

  it("returns count 0 and unchanged value for benign text", () => {
    const result = redactArchitectureDisclosure("Renamed a variable for clarity.");
    expect(result.count).toBe(0);
    expect(result.value).toBe("Renamed a variable for clarity.");
  });
});
