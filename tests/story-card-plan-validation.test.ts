import { describe, expect, it } from "vitest";
import type { StoryCardCandidate } from "../src/story-card-slots.js";
import {
  STORY_CARD_VIOLATIONS,
  validateStoryCardPlanEntries
} from "../src/story-card-plan.js";

const candidates: StoryCardCandidate[] = [
  {
    id: "typo",
    slots: {
      headline: { type: "text", required: true, maxLength: 40 },
      kicker: { type: "text", required: false, maxLength: 24 }
    }
  },
  {
    id: "terminal",
    slots: {
      prompt: { type: "text", required: true, maxLength: 24 },
      command: { type: "text", required: true, maxLength: 60 },
      output: { type: "lines", required: false, maxLines: 2, maxLength: 20 }
    }
  }
];

function entry(type: string, slots: { name: string; lines: string[] }[]) {
  return { type, slots };
}

describe("validateStoryCardPlanEntries", () => {
  it("accepts a well-formed card and normalizes text slots to strings", () => {
    const outcomes = validateStoryCardPlanEntries(
      [entry("typo", [{ name: "headline", lines: ["오늘의 한 줄"] }])],
      candidates
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("accepted");
    if (outcomes[0].status !== "accepted") return;
    expect(outcomes[0].entry).toEqual({
      type: "typo",
      slots: { headline: "오늘의 한 줄" }
    });
  });

  it("keeps lines slots as arrays", () => {
    const outcomes = validateStoryCardPlanEntries(
      [
        entry("terminal", [
          { name: "prompt", lines: ["~/dev"] },
          { name: "command", lines: ["pnpm test"] },
          { name: "output", lines: ["ok", "done"] }
        ])
      ],
      candidates
    );

    expect(outcomes[0].status).toBe("accepted");
    if (outcomes[0].status !== "accepted") return;
    expect(outcomes[0].entry.slots.output).toEqual(["ok", "done"]);
  });

  it("rejects a type that is not in today's candidate list", () => {
    const outcomes = validateStoryCardPlanEntries(
      [entry("diff", [{ name: "filename", lines: ["a.ts"] }])],
      candidates
    );

    expect(outcomes[0].status).toBe("rejected");
    if (outcomes[0].status !== "rejected") return;
    expect(outcomes[0].violations[0].code).toBe(
      STORY_CARD_VIOLATIONS.unknownCardType
    );
    expect(outcomes[0].rawType).toBe("diff");
  });

  it("rejects too many lines", () => {
    const outcomes = validateStoryCardPlanEntries(
      [
        entry("terminal", [
          { name: "prompt", lines: ["~"] },
          { name: "command", lines: ["ls"] },
          { name: "output", lines: ["a", "b", "c"] }
        ])
      ],
      candidates
    );

    expect(outcomes[0].status).toBe("rejected");
    if (outcomes[0].status !== "rejected") return;
    expect(outcomes[0].violations.map((v) => v.code)).toContain(
      STORY_CARD_VIOLATIONS.tooManyLines
    );
  });

  it("rejects a line that exceeds the per-line length limit", () => {
    const outcomes = validateStoryCardPlanEntries(
      [
        entry("terminal", [
          { name: "prompt", lines: ["~"] },
          { name: "command", lines: ["ls"] },
          { name: "output", lines: ["x".repeat(21)] }
        ])
      ],
      candidates
    );

    expect(outcomes[0].status).toBe("rejected");
    if (outcomes[0].status !== "rejected") return;
    expect(outcomes[0].violations.map((v) => v.code)).toContain(
      STORY_CARD_VIOLATIONS.lineTooLong
    );
  });

  it("rejects text that exceeds maxLength", () => {
    const outcomes = validateStoryCardPlanEntries(
      [entry("typo", [{ name: "headline", lines: ["가".repeat(41)] }])],
      candidates
    );

    expect(outcomes[0].status).toBe("rejected");
    if (outcomes[0].status !== "rejected") return;
    expect(outcomes[0].violations.map((v) => v.code)).toContain(
      STORY_CARD_VIOLATIONS.textTooLong
    );
  });

  it("rejects a missing required slot", () => {
    const outcomes = validateStoryCardPlanEntries(
      [entry("typo", [{ name: "kicker", lines: ["부제"] }])],
      candidates
    );

    expect(outcomes[0].status).toBe("rejected");
    if (outcomes[0].status !== "rejected") return;
    expect(outcomes[0].violations.map((v) => v.code)).toContain(
      STORY_CARD_VIOLATIONS.missingRequiredSlot
    );
  });

  it("rejects a required slot filled with whitespace only", () => {
    const outcomes = validateStoryCardPlanEntries(
      [entry("typo", [{ name: "headline", lines: ["   "] }])],
      candidates
    );

    expect(outcomes[0].status).toBe("rejected");
    if (outcomes[0].status !== "rejected") return;
    expect(outcomes[0].violations.map((v) => v.code)).toContain(
      STORY_CARD_VIOLATIONS.emptySlot
    );
  });

  it("rejects an unknown slot key", () => {
    const outcomes = validateStoryCardPlanEntries(
      [
        entry("typo", [
          { name: "headline", lines: ["제목"] },
          { name: "subtitle", lines: ["없는 슬롯"] }
        ])
      ],
      candidates
    );

    expect(outcomes[0].status).toBe("rejected");
    if (outcomes[0].status !== "rejected") return;
    expect(outcomes[0].violations.map((v) => v.code)).toContain(
      STORY_CARD_VIOLATIONS.unknownSlotKey
    );
  });

  it("rejects a text slot given more than one line", () => {
    const outcomes = validateStoryCardPlanEntries(
      [entry("typo", [{ name: "headline", lines: ["한 줄", "두 줄"] }])],
      candidates
    );

    expect(outcomes[0].status).toBe("rejected");
    if (outcomes[0].status !== "rejected") return;
    expect(outcomes[0].violations.map((v) => v.code)).toContain(
      STORY_CARD_VIOLATIONS.slotTypeMismatch
    );
  });

  it("rejects a structurally malformed entry without throwing", () => {
    const outcomes = validateStoryCardPlanEntries(
      [null, { type: 42 }, { type: "typo", slots: "nope" }],
      candidates
    );

    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
    }
  });

  it("judges each card independently — one bad card does not reject its sibling", () => {
    const outcomes = validateStoryCardPlanEntries(
      [
        entry("typo", [{ name: "headline", lines: ["멀쩡한 카드"] }]),
        entry("nope", [{ name: "headline", lines: ["없는 종류"] }])
      ],
      candidates
    );

    expect(outcomes[0].status).toBe("accepted");
    expect(outcomes[1].status).toBe("rejected");
    expect(outcomes[1].cardIndex).toBe(1);
  });

  it("puts a human-readable reason in every violation message", () => {
    const outcomes = validateStoryCardPlanEntries(
      [entry("diff", [{ name: "filename", lines: ["a.ts"] }])],
      candidates
    );

    if (outcomes[0].status !== "rejected") throw new Error("expected rejection");
    expect(outcomes[0].violations[0].message).toContain("diff");
    expect(outcomes[0].violations[0].message.length).toBeGreaterThan(0);
  });
});
