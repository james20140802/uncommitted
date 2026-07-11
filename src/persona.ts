import { isRecord } from "./type-guards.js";

/**
 * Structured persona schema (UNC-209 / UNC-199).
 *
 * Promotes the previous free-text `persona: string` config field to a
 * structured object: a **preset is just a named bundle of knob values**, so
 * presets and fine-grained overrides are the same mechanism at two
 * altitudes. See `docs/persona-system.md` §1-2 for the design rationale and
 * the source-of-truth preset directions.
 *
 * Global safety boundaries (never attack identity, ability, appearance,
 * mental health, personal value, or real life) are enforced elsewhere
 * (caption/story safety prompts) and are not encoded here.
 */

export const PERSONA_PRESET_NAMES = [
  "까칠한 시니어",
  "다정한 페어",
  "시니컬한 관찰자",
  "텐션 높은 주니어"
] as const;

export type PersonaPresetName = (typeof PERSONA_PRESET_NAMES)[number];

export type PersonaRelationship = "senior" | "peer" | "junior" | "observer";
export type PersonaRegister = "formal" | "casual" | "mixed";
export type PersonaSentenceLength = "terse" | "medium" | "long";
export type PersonaEmojiUsage = "none" | "light" | "heavy";
export type PersonaLangMix = "low" | "medium" | "high";
export type PersonaHumorStyle = "dry" | "warm" | "sarcastic" | "absurd";

export interface PersonaIdentity {
  name: string;
  relationship: PersonaRelationship;
  backstory: string;
}

export interface PersonaVoice {
  register: PersonaRegister;
  sentenceLength: PersonaSentenceLength;
  verbalTics: string[];
  emoji: PersonaEmojiUsage;
  koreanEnglishMix: PersonaLangMix;
  /** 음/슴 일변도 금지 룰 on — always true for authored presets. */
  registerVariety: boolean;
}

export interface PersonaHumor {
  targets: string[];
  style: PersonaHumorStyle;
}

export interface PersonaReactions {
  notices: string[];
  annoyedBy: string[];
  delightedBy: string[];
}

export interface Persona {
  preset: PersonaPresetName;
  identity: PersonaIdentity;
  voice: PersonaVoice;
  humor: PersonaHumor;
  reactions: PersonaReactions;
}

/**
 * A preset is a persona plus the `roastLevel` (humor intensity) it ships
 * with. `roastLevel` intentionally stays the existing top-level config field
 * rather than a duplicate knob inside `Persona.humor`.
 */
export interface PersonaPresetBundle {
  roastLevel: number;
  persona: Persona;
}

export const PERSONA_PRESETS: Record<PersonaPresetName, PersonaPresetBundle> = {
  "까칠한 시니어": {
    roastLevel: 4,
    persona: {
      preset: "까칠한 시니어",
      identity: {
        name: "까칠한 시니어",
        relationship: "senior",
        backstory: "10년차 시니어 개발자. 코드 리뷰에서 팩트로 찌른다. 잔소리 같지만 대부분 맞는 말이다."
      },
      voice: {
        register: "formal",
        sentenceLength: "terse",
        verbalTics: ["정확히 말하면", "그건 좀..."],
        emoji: "none",
        koreanEnglishMix: "low",
        registerVariety: true
      },
      humor: {
        targets: ["미룬 리팩터링", "테스트 안 짠 코드", "임시방편 커밋"],
        style: "dry"
      },
      reactions: {
        notices: ["미룬 TODO", "테스트 커버리지", "커밋 메시지 품질"],
        annoyedBy: ["같은 실수 반복", "핑계 섞인 커밋 메시지"],
        delightedBy: ["깔끔하게 정리된 diff"]
      }
    }
  },
  "다정한 페어": {
    roastLevel: 1,
    persona: {
      preset: "다정한 페어",
      identity: {
        name: "다정한 페어",
        relationship: "peer",
        backstory: "옆자리 페어 프로그래머. 실수해도 다독여주고 같이 고민해준다."
      },
      voice: {
        register: "casual",
        sentenceLength: "medium",
        verbalTics: ["괜찮아요", "같이 해봐요"],
        emoji: "light",
        koreanEnglishMix: "medium",
        registerVariety: true
      },
      humor: {
        targets: ["오늘 놓친 것", "귀여운 실수"],
        style: "warm"
      },
      reactions: {
        notices: ["작은 진전", "고생한 흔적"],
        annoyedBy: ["필요 이상으로 자책하는 태도"],
        delightedBy: ["같이 해결한 문제", "사소한 성공"]
      }
    }
  },
  "시니컬한 관찰자": {
    roastLevel: 2,
    persona: {
      preset: "시니컬한 관찰자",
      identity: {
        name: "시니컬한 관찰자",
        relationship: "observer",
        backstory: "한 발짝 떨어져서 지켜보는 동료. 무심한 듯 보이지만 다 보고 있다."
      },
      voice: {
        register: "mixed",
        sentenceLength: "medium",
        verbalTics: ["...음.", "그렇군."],
        emoji: "none",
        koreanEnglishMix: "medium",
        registerVariety: true
      },
      humor: {
        targets: ["반복되는 패턴", "말뿐인 다짐"],
        style: "sarcastic"
      },
      reactions: {
        notices: ["반복되는 패턴", "말과 행동의 차이"],
        annoyedBy: ["과장된 자평"],
        delightedBy: ["예상 밖의 조용한 하루"]
      }
    }
  },
  "텐션 높은 주니어": {
    roastLevel: 1,
    persona: {
      preset: "텐션 높은 주니어",
      identity: {
        name: "텐션 높은 주니어",
        relationship: "junior",
        backstory: "입사 6개월차 주니어. 뭐든 리액션이 크고 신나 한다."
      },
      voice: {
        register: "casual",
        sentenceLength: "medium",
        verbalTics: ["대박", "미쳤다"],
        emoji: "heavy",
        koreanEnglishMix: "high",
        registerVariety: true
      },
      humor: {
        targets: ["사소한 승리", "황당한 버그"],
        style: "absurd"
      },
      reactions: {
        notices: ["새로운 시도", "오늘의 텐션"],
        annoyedBy: ["재미없게 흘러간 하루"],
        delightedBy: ["아주 작은 성공도"]
      }
    }
  }
};

/** Matches the current medium-register / roast-2 default voice. */
export const DEFAULT_PERSONA_PRESET: PersonaPresetName = "시니컬한 관찰자";

/**
 * Per-knob-group override applied on top of a preset. Each present group is
 * shallow-merged over the preset's group (preset < override); `roastLevel`
 * sits outside `Persona` (it stays the existing top-level config field) and
 * wins over the preset's `roastLevel` when supplied.
 */
export type PersonaOverride = Partial<{
  identity: Partial<PersonaIdentity>;
  voice: Partial<PersonaVoice>;
  humor: Partial<PersonaHumor>;
  reactions: Partial<PersonaReactions>;
  roastLevel: number;
}>;

/**
 * Deep-enough clone of a `Persona`: every knob group (and the string arrays
 * they hold) gets a fresh object/array, so callers can freely mutate the
 * result without ever touching a `PERSONA_PRESETS` entry. `PERSONA_PRESETS`
 * and `migratePersona` return the shared default persona object by
 * reference, so anything that resolves/overrides a preset must clone before
 * handing a persona back to a caller.
 */
function clonePersona(persona: Persona): Persona {
  return {
    preset: persona.preset,
    identity: { ...persona.identity },
    voice: { ...persona.voice, verbalTics: [...persona.voice.verbalTics] },
    humor: { ...persona.humor, targets: [...persona.humor.targets] },
    reactions: {
      notices: [...persona.reactions.notices],
      annoyedBy: [...persona.reactions.annoyedBy],
      delightedBy: [...persona.reactions.delightedBy]
    }
  };
}

/**
 * Shallow-merge `partial` over `base`, one knob group at a time: a group
 * present in `partial` is merged key-by-key over the matching group in
 * `base`; a group absent from `partial` is carried over unchanged. Always
 * returns a freshly cloned `Persona` — never mutates `base` (or, transitively,
 * a `PERSONA_PRESETS` entry passed in as `base`).
 */
export function applyPersonaOverride(base: Persona, partial: PersonaOverride): Persona {
  const cloned = clonePersona(base);

  return {
    preset: cloned.preset,
    identity: partial.identity
      ? { ...cloned.identity, ...partial.identity }
      : cloned.identity,
    voice: partial.voice ? { ...cloned.voice, ...partial.voice } : cloned.voice,
    humor: partial.humor ? { ...cloned.humor, ...partial.humor } : cloned.humor,
    reactions: partial.reactions
      ? { ...cloned.reactions, ...partial.reactions }
      : cloned.reactions
  };
}

/**
 * Resolve a preset name (+ optional per-knob override) into the
 * `{ roastLevel, persona }` bundle to persist into `GlobalConfig`. Always
 * returns a fresh `Persona` (via `clonePersona`/`applyPersonaOverride`), so
 * repeated calls never corrupt the shared `PERSONA_PRESETS` entry.
 */
export function resolvePersonaPreset(
  name: PersonaPresetName,
  override?: PersonaOverride
): { roastLevel: number; persona: Persona } {
  const bundle = PERSONA_PRESETS[name];
  const persona = override
    ? applyPersonaOverride(bundle.persona, override)
    : clonePersona(bundle.persona);
  const roastLevel = override?.roastLevel ?? bundle.roastLevel;

  return { roastLevel, persona };
}

function isPersonaPresetName(value: unknown): value is PersonaPresetName {
  return (
    typeof value === "string" &&
    (PERSONA_PRESET_NAMES as readonly string[]).includes(value)
  );
}

function isPersonaRelationship(value: unknown): value is PersonaRelationship {
  return (
    value === "senior" ||
    value === "peer" ||
    value === "junior" ||
    value === "observer"
  );
}

function isPersonaRegister(value: unknown): value is PersonaRegister {
  return value === "formal" || value === "casual" || value === "mixed";
}

function isPersonaSentenceLength(value: unknown): value is PersonaSentenceLength {
  return value === "terse" || value === "medium" || value === "long";
}

function isPersonaEmojiUsage(value: unknown): value is PersonaEmojiUsage {
  return value === "none" || value === "light" || value === "heavy";
}

function isPersonaLangMix(value: unknown): value is PersonaLangMix {
  return value === "low" || value === "medium" || value === "high";
}

function isPersonaHumorStyle(value: unknown): value is PersonaHumorStyle {
  return (
    value === "dry" ||
    value === "warm" ||
    value === "sarcastic" ||
    value === "absurd"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPersonaIdentity(value: unknown): value is PersonaIdentity {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isPersonaRelationship(value.relationship) &&
    typeof value.backstory === "string"
  );
}

function isPersonaVoice(value: unknown): value is PersonaVoice {
  return (
    isRecord(value) &&
    isPersonaRegister(value.register) &&
    isPersonaSentenceLength(value.sentenceLength) &&
    isStringArray(value.verbalTics) &&
    isPersonaEmojiUsage(value.emoji) &&
    isPersonaLangMix(value.koreanEnglishMix) &&
    typeof value.registerVariety === "boolean"
  );
}

function isPersonaHumor(value: unknown): value is PersonaHumor {
  return (
    isRecord(value) &&
    isStringArray(value.targets) &&
    isPersonaHumorStyle(value.style)
  );
}

function isPersonaReactions(value: unknown): value is PersonaReactions {
  return (
    isRecord(value) &&
    isStringArray(value.notices) &&
    isStringArray(value.annoyedBy) &&
    isStringArray(value.delightedBy)
  );
}

/** Structural guard for a fully-formed `Persona` (rejects strings and partial objects). */
export function isPersona(value: unknown): value is Persona {
  return (
    isRecord(value) &&
    isPersonaPresetName(value.preset) &&
    isPersonaIdentity(value.identity) &&
    isPersonaVoice(value.voice) &&
    isPersonaHumor(value.humor) &&
    isPersonaReactions(value.reactions)
  );
}

/**
 * Normalize a raw persona value (as read from disk) into a structured
 * `Persona`. Handles the three shapes a config file may hold:
 *
 * - already-structured `Persona` → returned unchanged.
 * - legacy free-text `string` → the default preset persona, with its
 *   backstory replaced by the original text (so the old voice input is not
 *   silently discarded).
 * - anything else (`undefined`, wrong type, malformed object) → the default
 *   preset persona, unchanged.
 */
export function migratePersona(rawPersona: unknown): Persona {
  if (isPersona(rawPersona)) {
    return rawPersona;
  }

  const defaultPersona = PERSONA_PRESETS[DEFAULT_PERSONA_PRESET].persona;

  if (typeof rawPersona === "string" && rawPersona.length > 0) {
    return {
      ...defaultPersona,
      identity: {
        ...defaultPersona.identity,
        backstory: rawPersona
      }
    };
  }

  return defaultPersona;
}

/** Extract and migrate `.persona` off a config record (mirrors `selectDraftRoot`). */
export function selectPersona(value: unknown): Persona {
  if (isRecord(value)) {
    return migratePersona(value.persona);
  }
  return migratePersona(undefined);
}

const eumSeumEnding = /[음슴][.!]?$/;
const yoOrQuestionEnding = /(요|\?)[.!]?$/;

/**
 * Heuristic for the "음/슴 일변도 금지" rule (Task 3 caption voice check):
 * true when every non-empty line ends in 음/슴 and none end in 요/? — i.e.
 * the sentence-ending register never varies.
 */
export function isRegisterUniform(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return false;
  }

  const allEumSeum = lines.every((line) => eumSeumEnding.test(line));
  const anyYoOrQuestion = lines.some((line) => yoOrQuestionEnding.test(line));

  return allEumSeum && !anyYoOrQuestion;
}
