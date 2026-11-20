/**
 * 고도 규칙 (UNC-248 → UNC-308). story 원고·캡션·카드 프롬프트가 **같은 문장**을
 * 쓰도록 이 모듈 한 곳에서만 소유한다 (korean-surface-instructions와 같은 방식).
 *
 * - framing / noInvention: UNC-248에서 diary-generator에 있던 두 줄을 그대로 옮겼다.
 *   noInvention은 "보편화가 지어내기로 번지는" 실패 모드를 막는 경계라 framing과
 *   항상 붙어 있어야 한다. 캡션은 이 두 줄만 받아 옮기기 전과 바이트 단위로 같다.
 * - insiderTerms (UNC-308): 판정 기준을 "코딩 용어인가"에서 "이 프로젝트를 아는
 *   사람만 이해할 수 있는 말인가"로 넓힌다. 고유 식별자뿐 아니라 평범한 한국어로 된
 *   프로젝트 내부 개념어도 막고, 일반 개발 용어는 허용한다. story 원고와 카드에만
 *   붙는다 (캡션 고도 규칙은 UNC-308 범위 밖).
 */
export type AltitudeTarget = "story" | "caption" | "card";

export const ALTITUDE_RULES = {
  framing:
    "Altitude rule: raise the framing, never the facts. Describe the work you were given as a situation any developer would recognize, instead of naming the specific ticket, screen, module, or file it happened in.",
  noInvention:
    "Raising altitude means rewording the same event. It never means adding one: do not invent work, drama, stakes, or consequences the activity summary does not support. Universal does not mean vague: the framing must still be specific enough that only today's work fits it. If the line could be published unchanged on any other day, it is too high.",
  insiderTerms:
    "Insider-term rule: write for a reader who has never seen this project. A word or phrase that only someone who knows this project could understand must not appear, even when it is written in ordinary Korean — for example a name this project gave to one of its own mechanisms, stages, or states, or repository or project names that mean nothing to an outsider. Rewrite it as the situation that reader would recognize. The same goes for a plain word whose referent only an insider can tell — say what kind of thing it is (for example \"모델 이름\" rather than a bare \"이름\") so an outsider knows what is being talked about. General developer terms that any developer knows, such as \"회귀 테스트 통과\", may stay. This applies even when the term comes from the story manuscript or the input summary: keep the same fact and change only the words."
} as const;

export function buildAltitudeLines(target: AltitudeTarget): string[] {
  const lines: string[] = [ALTITUDE_RULES.framing, ALTITUDE_RULES.noInvention];

  return target === "caption" ? lines : [...lines, ALTITUDE_RULES.insiderTerms];
}
