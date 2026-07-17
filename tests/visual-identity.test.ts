import { describe, expect, it } from "vitest";
import {
  VISUAL_IDENTITY,
  visualIdentityPromptLines
} from "../src/visual-identity.js";

describe("visual identity layer (UNC-216)", () => {
  it("exposes non-empty palette, composition, and material grammar constants", () => {
    expect(VISUAL_IDENTITY.palette.trim().length).toBeGreaterThan(0);
    expect(VISUAL_IDENTITY.composition.trim().length).toBeGreaterThan(0);
    expect(VISUAL_IDENTITY.materialGrammar.trim().length).toBeGreaterThan(0);
  });

  it("produces deterministic prompt lines that surface every identity dimension", () => {
    const first = visualIdentityPromptLines();
    const second = visualIdentityPromptLines();

    expect(first).toEqual(second); // 결정적 — 무작위 없음
    const joined = first.join("\n");
    expect(joined).toContain(VISUAL_IDENTITY.palette);
    expect(joined).toContain(VISUAL_IDENTITY.composition);
    expect(joined).toContain(VISUAL_IDENTITY.materialGrammar);
  });

  it("keeps identity constants free of unsafe token shapes", () => {
    const joined = visualIdentityPromptLines().join("\n");
    expect(joined).not.toMatch(/sk-[A-Za-z0-9]/); // API key 형태 없음
    expect(joined).not.toMatch(/process\.env/);
    expect(joined).not.toContain("`"); // 코드 백틱 없음
  });
});
