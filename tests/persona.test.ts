import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONA_PRESET,
  PERSONA_PRESET_NAMES,
  PERSONA_PRESETS,
  isPersona,
  isRegisterUniform,
  migratePersona,
  selectPersona
} from "../src/persona.js";

describe("PERSONA_PRESETS", () => {
  it("has a bundle for every preset name, with a consistent preset key", () => {
    for (const name of PERSONA_PRESET_NAMES) {
      const bundle = PERSONA_PRESETS[name];
      expect(bundle).toBeDefined();
      expect(bundle.persona.preset).toBe(name);
      expect(Number.isInteger(bundle.roastLevel)).toBe(true);
      expect(bundle.roastLevel).toBeGreaterThanOrEqual(0);
      expect(bundle.roastLevel).toBeLessThanOrEqual(5);
      expect(bundle.persona.voice.registerVariety).toBe(true);
    }
  });
});

describe("DEFAULT_PERSONA_PRESET", () => {
  it("is a valid preset name whose bundle has roastLevel 2", () => {
    expect(PERSONA_PRESET_NAMES).toContain(DEFAULT_PERSONA_PRESET);
    expect(DEFAULT_PERSONA_PRESET).toBe("시니컬한 관찰자");
    expect(PERSONA_PRESETS[DEFAULT_PERSONA_PRESET].roastLevel).toBe(2);
  });
});

describe("isPersona", () => {
  it("accepts a real preset persona", () => {
    expect(isPersona(PERSONA_PRESETS[DEFAULT_PERSONA_PRESET].persona)).toBe(true);
  });

  it("rejects a string", () => {
    expect(isPersona("legacy free text")).toBe(false);
  });

  it("rejects a partial object", () => {
    expect(isPersona({ preset: DEFAULT_PERSONA_PRESET })).toBe(false);
  });
});

describe("migratePersona", () => {
  it("wraps legacy free text as the default preset persona's backstory", () => {
    const migrated = migratePersona("legacy free text");
    expect(migrated.preset).toBe(DEFAULT_PERSONA_PRESET);
    expect(migrated.identity.backstory).toBe("legacy free text");
  });

  it("returns the default preset persona unchanged for undefined", () => {
    expect(migratePersona(undefined)).toEqual(
      PERSONA_PRESETS[DEFAULT_PERSONA_PRESET].persona
    );
  });

  it("returns the default preset persona unchanged for a non-string, non-persona value", () => {
    expect(migratePersona(42)).toEqual(
      PERSONA_PRESETS[DEFAULT_PERSONA_PRESET].persona
    );
  });

  it("returns an already-structured persona unchanged", () => {
    const structured = PERSONA_PRESETS["까칠한 시니어"].persona;
    expect(migratePersona(structured)).toEqual(structured);
  });
});

describe("selectPersona", () => {
  it("reads .persona off a config record and migrates it", () => {
    expect(selectPersona({ persona: "old string" })).toEqual(
      migratePersona("old string")
    );
  });
});

describe("isRegisterUniform", () => {
  it("returns true when every sentence ends in 음/슴", () => {
    expect(isRegisterUniform("봤음\n했음\n갔음")).toBe(true);
  });

  it("returns false for mixed endings", () => {
    expect(isRegisterUniform("봤음\n했어요\n갔을까요?")).toBe(false);
  });
});
