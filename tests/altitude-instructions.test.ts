import { describe, expect, it } from "vitest";
import {
  ALTITUDE_RULES,
  buildAltitudeLines
} from "../src/altitude-instructions.js";

describe("altitude instructions (UNC-308)", () => {
  it("keeps the caption altitude lines byte-identical to the UNC-248 prompt", () => {
    expect(buildAltitudeLines("caption")).toEqual([
      "Altitude rule: raise the framing, never the facts. Describe the work you were given as a situation any developer would recognize, instead of naming the specific ticket, screen, module, or file it happened in.",
      "Raising altitude means rewording the same event. It never means adding one: do not invent work, drama, stakes, or consequences the activity summary does not support. Universal does not mean vague: the framing must still be specific enough that only today's work fits it. If the line could be published unchanged on any other day, it is too high."
    ]);
  });

  it("gives the story manuscript and card prompts the same sentences, including the insider-term rule", () => {
    const story = buildAltitudeLines("story");
    const card = buildAltitudeLines("card");

    expect(card).toEqual(story);
    expect(story).toEqual([
      ALTITUDE_RULES.framing,
      ALTITUDE_RULES.noInvention,
      ALTITUDE_RULES.insiderTerms
    ]);
  });

  it("judges terms by whether an outsider can understand them, not by whether they are code words", () => {
    const rule = ALTITUDE_RULES.insiderTerms;

    // 평범한 한국어로 된 프로젝트 내부 개념어와 저장소·프로젝트 이름까지 포함
    expect(rule).toContain("ordinary Korean");
    expect(rule).toContain("repository or project names");
    // 외부 사람이 알아볼 상황으로 바꿔 쓴다
    expect(rule).toContain("situation that reader would recognize");
    // 뜻은 평범해도 무엇을 가리키는지 내부자만 아는 말은 대상의 종류를 밝힌다
    expect(rule).toContain("referent only an insider can tell");
    // 일반 개발 용어는 허용
    expect(rule).toContain("회귀 테스트 통과");
    expect(rule).toContain("may stay");
    // 원고·입력 요약에서 온 말이어도 적용하되, 사실은 그대로 둔다
    expect(rule).toContain("story manuscript");
    expect(rule).toContain("input summary");
    expect(rule).toContain("keep the same fact");
  });
});
