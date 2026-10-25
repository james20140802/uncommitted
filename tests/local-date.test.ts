import { afterEach, describe, expect, it } from "vitest";
import { localDateOf, localDayWindow, todayLocal } from "../src/local-date.js";

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

describe("localDateOf", () => {
  it("returns the local calendar date of the instant", () => {
    expect(localDateOf("2026-10-10T20:30:00Z", "Asia/Seoul")).toBe("2026-10-11");
    expect(localDateOf("2026-10-10T20:30:00Z", "UTC")).toBe("2026-10-10");
    expect(localDateOf("2026-10-11T05:30:00+09:00", "UTC")).toBe("2026-10-10");
  });

  it("falls back to the first 10 characters when the timestamp cannot be parsed", () => {
    expect(localDateOf("garbage", "Asia/Seoul")).toBe("garbage");
  });

  it("uses the system time zone by default", () => {
    process.env.TZ = "Asia/Seoul";
    expect(localDateOf("2026-10-10T20:30:00Z")).toBe("2026-10-11");
  });
});

describe("todayLocal", () => {
  it("resolves the scheduled 23:30 KST run to the local date", () => {
    expect(todayLocal("2026-10-11T14:30:00Z", "Asia/Seoul")).toBe("2026-10-11");
  });

  it("accepts a Date", () => {
    expect(todayLocal(new Date("2026-10-11T14:30:00Z"), "Asia/Seoul")).toBe("2026-10-11");
  });
});

describe("localDayWindow", () => {
  it("returns the local day bounds as UTC ISO strings", () => {
    expect(localDayWindow("2026-10-11", "Asia/Seoul")).toEqual({
      start: "2026-10-10T15:00:00.000Z",
      end: "2026-10-11T15:00:00.000Z"
    });
    expect(localDayWindow("2026-10-11", "UTC")).toEqual({
      start: "2026-10-11T00:00:00.000Z",
      end: "2026-10-12T00:00:00.000Z"
    });
  });

  it("handles a DST transition day", () => {
    const { start, end } = localDayWindow("2026-03-08", "America/New_York");
    expect(start).toBe("2026-03-08T05:00:00.000Z");
    expect(end).toBe("2026-03-09T04:00:00.000Z");
    expect(Date.parse(end) - Date.parse(start)).toBe(23 * 60 * 60 * 1000);
    expect(localDayWindow("2026-11-01", "America/New_York")).toEqual({
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-11-02T05:00:00.000Z"
    });
  });

  it("starts the day at the first valid instant when local midnight is skipped", () => {
    // Chile springs forward at 00:00 → 01:00 on 2026-09-06, so that day starts at 01:00 -03.
    expect(localDayWindow("2026-09-06", "America/Santiago").start).toBe("2026-09-06T04:00:00.000Z");
    expect(localDayWindow("2026-09-05", "America/Santiago")).toEqual({
      start: "2026-09-05T04:00:00.000Z",
      end: "2026-09-06T04:00:00.000Z"
    });
  });
});
