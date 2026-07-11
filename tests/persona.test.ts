import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONA_PRESET,
  PERSONA_PRESET_NAMES,
  PERSONA_PRESETS,
  applyPersonaOverride,
  isPersona,
  isRegisterUniform,
  migratePersona,
  resolvePersonaPreset,
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

describe("resolvePersonaPreset", () => {
  it("returns the bundle's roastLevel and persona for a plain preset name", () => {
    const resolved = resolvePersonaPreset("까칠한 시니어");
    expect(resolved.roastLevel).toBe(PERSONA_PRESETS["까칠한 시니어"].roastLevel);
    expect(resolved.persona).toEqual(PERSONA_PRESETS["까칠한 시니어"].persona);
  });

  it("layers a voice override over the preset while leaving other knobs intact", () => {
    const resolved = resolvePersonaPreset("까칠한 시니어", {
      voice: { emoji: "heavy" }
    });
    const original = PERSONA_PRESETS["까칠한 시니어"].persona;

    expect(resolved.persona.voice.emoji).toBe("heavy");
    expect(resolved.persona.voice.register).toBe(original.voice.register);
    expect(resolved.persona.voice.sentenceLength).toBe(original.voice.sentenceLength);
    expect(resolved.persona.identity).toEqual(original.identity);
    expect(resolved.persona.humor).toEqual(original.humor);
    expect(resolved.persona.reactions).toEqual(original.reactions);
    expect(resolved.roastLevel).toBe(PERSONA_PRESETS["까칠한 시니어"].roastLevel);
  });

  it("lets a roastLevel override win over the preset's roastLevel", () => {
    const resolved = resolvePersonaPreset("까칠한 시니어", { roastLevel: 5 });
    expect(resolved.roastLevel).toBe(5);
    // Persona knobs are untouched by a roastLevel-only override.
    expect(resolved.persona).toEqual(PERSONA_PRESETS["까칠한 시니어"].persona);
  });

  it("does not corrupt the shared preset bundle across repeated resolutions", () => {
    const pristine = JSON.parse(
      JSON.stringify(PERSONA_PRESETS["까칠한 시니어"])
    );

    resolvePersonaPreset("까칠한 시니어", {
      voice: { emoji: "heavy" },
      humor: { style: "absurd" },
      roastLevel: 0
    });

    expect(PERSONA_PRESETS["까칠한 시니어"]).toEqual(pristine);

    const resolvedAgain = resolvePersonaPreset("까칠한 시니어");
    expect(resolvedAgain).toEqual(pristine);
  });
});

describe("applyPersonaOverride", () => {
  it("shallow-merges each knob group, preset value losing to override value", () => {
    const base = PERSONA_PRESETS["다정한 페어"].persona;
    const merged = applyPersonaOverride(base, {
      identity: { name: "새 이름" },
      humor: { style: "absurd" }
    });

    expect(merged.identity.name).toBe("새 이름");
    expect(merged.identity.relationship).toBe(base.identity.relationship);
    expect(merged.identity.backstory).toBe(base.identity.backstory);
    expect(merged.humor.style).toBe("absurd");
    expect(merged.humor.targets).toEqual(base.humor.targets);
    expect(merged.voice).toEqual(base.voice);
    expect(merged.reactions).toEqual(base.reactions);
  });

  it("does not mutate the base persona object", () => {
    const base = PERSONA_PRESETS["다정한 페어"].persona;
    const baseCopy = JSON.parse(JSON.stringify(base));

    applyPersonaOverride(base, { voice: { emoji: "none" } });

    expect(base).toEqual(baseCopy);
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
