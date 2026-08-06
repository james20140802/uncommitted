# 고도 상승 — 개별 사실을 보편 상황으로 프레이밍 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카드 슬롯 프롬프트와 캡션 프롬프트 양쪽에 "고도 규칙 / 반어 프레임 / 영어 명사구 억제 + 내부 식별자 정책" 지시문을 추가해, 같은 사실을 개별 식별자 대신 누구나 아는 보편 상황으로 프레이밍하게 한다. 사실 자체는 절대 바꾸지 않는다.

**Architecture:** `src/diary-generator.ts` 안의 두 프롬프트 빌더 — `buildDiaryInstructions()`(story.json 슬라이드 문구)와 `buildCaptionInstructions()`(캡션) — 는 공유 주입 지점이 없는 별개 함수다. 두 곳에 같은 문구가 복붙되는 것을 막기 위해, 각 규칙을 **모듈 스코프 문자열 상수 배열**로 한 번 정의하고 두 함수에서 spread 해 넣는다. 상수는 export 하지 않는다(테스트는 실제 프롬프트 출력 문자열을 assert 한다). 내부 식별자 정책은 코드보다 먼저 ADR 문서로 결정·기록하고(Task 1), 그 결정을 Task 4의 규칙 문구가 참조한다.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, ESLint, pnpm.

## Global Constraints

프로젝트 전역 제약. 모든 태스크에 암묵적으로 적용된다.

- **수정 금지 파일** — `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `.env`, `.env.*`, `**/secrets/*`, `**/credentials/*`, `AGENTS.md`. **주의: 이 저장소의 `CLAUDE.md`는 `AGENTS.md`로의 심볼릭 링크다 (`ls -la CLAUDE.md` 로 확인 가능). `CLAUDE.md`를 편집하면 잠긴 `AGENTS.md`를 편집하는 것이다 — 절대 하지 마라.**
- **새 의존성 추가 금지.** 이 계획의 어떤 태스크도 `pnpm add`를 필요로 하지 않는다. lockfile은 변경되지 않아야 한다.
- **자동 게시 코드 추가 금지** — SNS/Instagram 자동 업로드 관련 코드를 어떤 형태로도 추가하지 않는다 (제품 정책).
- **지어내기 금지** — 없는 작업·커밋·버그·기능·사용자 활동을 만들어내는 동작을 허용하는 방향의 변경은 금지. 이 계획의 프롬프트 규칙들은 이 경계를 **강화**해야지 약화시켜서는 안 된다.
- **테스트 러너는 vitest.** 테스트 파일은 `tests/*.test.ts`. `src/` 안에 테스트를 두지 않는다.
- **`docs/superpowers/`는 `.gitignore`에 있다** (`.gitignore:13`). 그런데 기존 spec·plan 문서들은 저장소에 추적되고 있다 (`git ls-files docs/` 로 확인: `docs/superpowers/specs/2026-05-16-unc-62-caption-voice-design.md` 등). 따라서 이 디렉토리 밑의 문서를 커밋할 때는 **`git add -f`** 를 써야 한다. 이는 기존 선례를 따르는 것이며, `.gitignore` 자체는 수정하지 마라.
- **macOS-first.** 큰 cross-platform 리팩토링을 하지 않는다.
- **TDD 필수** — 각 태스크는 실패하는 테스트 → 최소 구현 → 통과 → 커밋 순서로 진행한다.
- **커밋 규약** — gitmoji + `type(scope): 제목`, 본문, 그리고 푸터 두 줄:
  ```
  Refs: UNC-<sub-issue-number>
  🤖 Generated with Routine B (Uncommitted Builder v2)
  ```
- **작업 디렉토리** — 이미 준비된 워크트리 `/Users/drchasekim/Developer/uncommitted-UNC-234` (브랜치 `claude/UNC-234-altitude-framing`)에서만 작업한다. `superpowers:using-git-worktrees`를 실행하지 마라. 새 워크트리를 만들거나 `main`을 체크아웃하지 마라. `git push`는 하지 마라 (오케스트레이터가 한다).
- **검증 명령** — `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. 태스크 완료 전 최소 `pnpm test`와 `pnpm lint`, `pnpm typecheck`는 통과해야 한다.

## File Structure

| 파일 | 역할 | 태스크 |
| --- | --- | --- |
| `docs/superpowers/specs/2026-08-07-unc-247-internal-identifier-exposure-policy.md` (신규) | 내부 식별자 노출 정책 ADR — 선택지 (a)/(b)/(c) 중 결정과 근거 | T1 |
| `src/diary-generator.ts` (수정) | 프롬프트 규칙 상수 3종 추가 + `buildDiaryInstructions()`/`buildCaptionInstructions()` 양쪽에 주입, 기존 좁은 전문용어 규칙 확대 | T2, T3, T4 |
| `tests/diary-generator.test.ts` (수정) | 세 규칙에 대한 단위 테스트 + 조용한 날 정직성 회귀 테스트 | T2, T3, T4, T5 |

`src/diary-generator.ts`는 874줄로 이미 크지만, 이 변경은 기존 파일의 확립된 패턴(같은 파일 안에 프롬프트 빌더가 모여 있음)을 따른다. 파일 분할은 이 이슈 범위 밖이므로 하지 않는다.

---

### Task 1 (UNC-247): 내부 식별자 노출 정책 ADR 작성

이 태스크는 **문서만** 만든다. `src/` 코드를 수정하지 않는다. 테스트도 추가하지 않는다 (검증 가능한 런타임 동작이 없다).

**Files:**
- Create: `docs/superpowers/specs/2026-08-07-unc-247-internal-identifier-exposure-policy.md`

**Interfaces:**
- Consumes: 없음
- Produces: Task 4가 규칙 문구 안에서 이 문서 경로를 참조하고, 여기서 결정된 정책 값(= 옵션 (a) 전면 마스킹)을 프롬프트 문구로 옮긴다.

**결정 내용 (이 태스크의 산출물, 아래 그대로 쓸 것):**

선택지 중 **(a) 전면 마스킹**을 채택한다. 근거:
1. UNC-234의 목표 자체가 개별 → 보편 프레이밍이다. `FeedbackModal`을 그대로 출력하는 것은 부모 이슈가 명시적으로 "개별"의 예시로 든 형태다 (부모 이슈의 개별/보편 대조표).
2. 부모 이슈 Implementation Notes: "자동 게시로 가면 (c)의 리스크가 커진다" — 현행 유지는 배제된다.
3. (b)(티켓 ID만 제거, 화면 이름 허용)는 카드에 내부 화면 이름이 크게 박히는 문제를 해결하지 못한다. 카드 슬롯은 캡션보다 글자가 크고 시선이 집중되므로 노출 비용이 더 크다.
4. 마스킹은 **사실을 바꾸지 않는다.** 사건은 그대로 두고 이름만 보편 서술로 바꾸는 것이므로 지어내기 금지 규칙과 충돌하지 않는다.

**정책 정의 (문서에 반드시 포함할 것):**
- **내부 식별자**란: 티켓 키(`UNC-123`, `ABC-45` 형태), 내부 화면·모듈·클래스·파일 이름(`FeedbackModal`, `diary-generator.ts`, `buildCaptionInstructions`), 내부 브랜치·PR 제목에만 등장하는 고유명사.
- **내부 식별자가 아닌 것**(허용): 통용 약어(`CI`, `PR`, `API`, `UI`, `AI`, `JSON`, `URL`), 공개 도구·언어·플랫폼 이름(`Git`, `TypeScript`, `Instagram`), 해시태그 토큰(`#`으로 시작).
- **규칙**: 공개 산출물(story.json 슬라이드 문구, caption.txt)에 내부 식별자를 그대로 출력하지 않는다. 대신 그것이 가리키는 **보편 상황 서술**로 바꾼다. 예: `FeedbackModal이 입력 중에 끼어들지 않게 고쳤다` → `사람이 뭘 입력하는 중에 튀어나오는 모달`.
- **적용 지점**: 프롬프트 지시문 (`buildDiaryInstructions()`, `buildCaptionInstructions()`). 이 정책은 프롬프트 레벨 지시이며, 사후 정규식 마스킹 필터를 추가하는 것은 이 이슈 범위 밖이다 (향후 과제로 문서에 기록).
- **기록 위치에 관한 주석**: 부모 이슈 AC4는 "`CLAUDE.md` 또는 관련 문서"를 허용한다. 이 저장소의 `CLAUDE.md`는 `AGENTS.md`로의 심볼릭 링크이고 `AGENTS.md`는 자동화 잠금 파일이므로, 정책은 이 spec 문서에 기록한다. 이 사실도 문서 안에 한 줄로 남긴다.

- [ ] **Step 1: ADR 문서 작성**

`docs/superpowers/specs/2026-08-07-unc-247-internal-identifier-exposure-policy.md` 를 만들고, 아래 골격에 위 "결정 내용"과 "정책 정의"를 채워 넣는다. 기존 spec 문서 `docs/superpowers/specs/2026-05-16-unc-62-caption-voice-design.md` 의 형식을 먼저 읽고 톤과 헤딩 스타일을 맞춘다.

```markdown
# 내부 식별자 노출 정책 (UNC-247)

- 상태: 결정됨
- 날짜: 2026-08-07
- 관련 이슈: UNC-234 (부모), UNC-247 (이 결정), UNC-250 (프롬프트 반영)

## 맥락

<부모 이슈 UNC-234의 배경 요약 — 개별 사실이 카드에 그대로 박히는 문제, 실측 잔존 예시>

## 선택지

- (a) 전면 마스킹
- (b) 티켓 ID만 제거하고 화면·모듈 이름 허용
- (c) 현행 유지

## 결정

**(a) 전면 마스킹을 채택한다.**

<위 "결정 내용"의 근거 4개>

## 정책

<위 "정책 정의" 전체 — 내부 식별자 정의 / 허용 목록 / 규칙 / 예시 / 적용 지점>

## 기록 위치에 대한 주석

<CLAUDE.md → AGENTS.md 심볼릭 링크라 잠금 파일이므로 이 문서에 기록한다는 설명>

## 향후 과제

<사후 정규식 마스킹 필터는 이 이슈 범위 밖>
```

- [ ] **Step 2: 잠긴 파일을 건드리지 않았는지 확인**

Run:
```bash
git status --short --ignored=no && git status --short --ignored | grep superpowers
```
Expected: `AGENTS.md`나 `CLAUDE.md`가 어느 목록에도 없어야 한다. 있으면 즉시 `git restore` 하고 새 문서만 남긴다. (새 spec 파일 자체는 `docs/superpowers/`가 gitignore 대상이라 `--ignored` 쪽에만 보인다 — 정상이다.)

- [ ] **Step 3: 기존 검증이 여전히 통과하는지 확인**

Run:
```bash
pnpm test
```
Expected: PASS (문서만 추가했으므로 변화 없음)

- [ ] **Step 4: 커밋**

`docs/superpowers/`가 gitignore 대상이므로 **`-f`가 필수다** (기존 spec 문서들과 같은 방식).

```bash
git add -f docs/superpowers/specs/2026-08-07-unc-247-internal-identifier-exposure-policy.md
git commit -m "$(cat <<'EOF'
📝 docs(policy): decide internal identifier exposure policy

공개 산출물(슬라이드 문구·캡션)에 티켓 키와 내부 화면·모듈 이름을
그대로 출력하지 않고 보편 상황 서술로 바꾸는 전면 마스킹 정책을
채택하고 근거와 함께 기록한다. 통용 약어·공개 도구명·해시태그는 예외.

CLAUDE.md가 잠금 파일 AGENTS.md의 심볼릭 링크이므로 정책은 별도 spec
문서에 기록했다 (부모 AC4가 "관련 문서"를 허용).

Refs: UNC-247
🤖 Generated with Routine B (Uncommitted Builder v2)
EOF
)"
```

---

### Task 2 (UNC-248): 고도 규칙을 두 프롬프트에 주입

**Files:**
- Modify: `src/diary-generator.ts` (모듈 스코프 상수 추가 + `buildDiaryInstructions()` 약 297-331행, `buildCaptionInstructions()` 약 365-450행)
- Test: `tests/diary-generator.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: 모듈 스코프 상수 `const ALTITUDE_RULE_LINES: readonly string[]`. Task 3과 Task 4가 같은 파일에 같은 패턴(`const <RULE>_LINES`)으로 상수를 추가하고 두 함수에 spread 한다.

**규칙 문구 (정확히 이 문자열을 쓸 것 — 테스트가 부분 문자열로 assert 한다):**

```ts
const ALTITUDE_RULE_LINES = [
  "Altitude rule: raise the framing, never the facts. Describe the work you were given as a situation any developer would recognize, instead of naming the specific ticket, screen, module, or file it happened in.",
  "Raising altitude means rewording the same event. It never means adding one: do not invent work, drama, stakes, or consequences the activity summary does not support."
] as const;
```

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/diary-generator.test.ts`의 `describe("caption generator", ...)` 블록 안, 기존 `it("buildCaptionInstructions quiet-day variant mentions absence of work", ...)` 바로 다음에 아래를 추가한다.

```ts
  it("buildCaptionInstructions carries the altitude rule with its no-fabrication boundary (UNC-248)", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(instructions).toContain("Altitude rule: raise the framing, never the facts");
    expect(instructions).toContain(
      "instead of naming the specific ticket, screen, module, or file"
    );
    // 보편화가 지어내기로 번지지 않도록 같은 자리에 경계를 명시한다
    expect(instructions).toContain("Raising altitude means rewording the same event");
    expect(instructions).toContain(
      "do not invent work, drama, stakes, or consequences the activity summary does not support"
    );
  });
```

그리고 `describe("diary generator", ...)` 블록 안, 기존 `it("generates a quiet-day request without fabricating activity", ...)` 바로 앞에 아래를 추가한다. 카드 슬롯 프롬프트(`buildDiaryInstructions`)는 export 되어 있지 않으므로, 기존 테스트들과 같은 방식으로 `provider.requests[0].instructions`를 통해 검증한다.

```ts
  it("diary instructions carry the altitude rule with its no-fabrication boundary (UNC-248)", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft()
    });

    await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 4 }),
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("Altitude rule: raise the framing, never the facts");
    expect(instructions).toContain(
      "instead of naming the specific ticket, screen, module, or file"
    );
    expect(instructions).toContain("Raising altitude means rewording the same event");
    expect(instructions).toContain(
      "do not invent work, drama, stakes, or consequences the activity summary does not support"
    );
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run:
```bash
pnpm vitest run tests/diary-generator.test.ts -t "UNC-248"
```
Expected: FAIL — 두 테스트 모두 `expect(received).toContain(expected)` 로 실패 (문자열이 아직 프롬프트에 없음)

- [ ] **Step 3: 최소 구현**

`src/diary-generator.ts`에서 `function buildDiaryInstructions(` 정의 **바로 앞**에 상수를 추가한다.

```ts
/**
 * 고도 규칙 (UNC-248). 카드 슬롯 프롬프트와 캡션 프롬프트가 같은 문구를 쓰도록
 * 한 곳에서만 정의한다. 두 번째 줄은 "보편화가 지어내기로 번지는" 실패 모드를
 * 막는 경계이며, 첫 줄과 반드시 붙어 있어야 한다.
 */
const ALTITUDE_RULE_LINES = [
  "Altitude rule: raise the framing, never the facts. Describe the work you were given as a situation any developer would recognize, instead of naming the specific ticket, screen, module, or file it happened in.",
  "Raising altitude means rewording the same event. It never means adding one: do not invent work, drama, stakes, or consequences the activity summary does not support."
] as const;
```

`buildDiaryInstructions()`의 반환 배열에서, 기존 줄
```ts
    "Do not invent work, commits, bugs, features, shipped changes, or user activity.",
```
바로 **뒤**에 아래를 삽입한다 (지어내기 금지 줄과 인접하게 두어 경계를 함께 읽히게 한다).
```ts
    ...ALTITUDE_RULE_LINES,
```

`buildCaptionInstructions()`의 반환 배열에서, 기존 줄
```ts
    "Translate developer jargon (PR numbers, version tags, module or file names, commit hashes) into human stakes — what it actually meant for a person — instead of printing the raw term. Example: an \"archive-context PR\" becomes \"뒤로가기 버튼을 못 믿는 하루\", not the literal PR name. Someone who has never touched this project should still be able to read the caption and relate to it.",
```
바로 **뒤**에 아래를 삽입한다.
```ts
    ...ALTITUDE_RULE_LINES,
```

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run:
```bash
pnpm vitest run tests/diary-generator.test.ts -t "UNC-248"
```
Expected: PASS (2 passed)

- [ ] **Step 5: 전체 검증**

Run:
```bash
pnpm test && pnpm lint && pnpm typecheck
```
Expected: 전부 PASS. 기존 테스트가 깨지면 — 특히 `instructions` 를 `not.toContain` 으로 검사하는 기존 단언들 — 새 문구가 그 금지 문자열을 포함하지 않는지 확인하고, 포함한다면 위 규칙 문구가 아니라 **테스트를 읽고 원인을 파악한 뒤** 규칙 문구 쪽을 조정한다. 기존 단언을 삭제하지 마라.

- [ ] **Step 6: 커밋**

```bash
git add src/diary-generator.ts tests/diary-generator.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(diary-generator): add the altitude rule to both prompts

카드 슬롯 프롬프트와 캡션 프롬프트가 같은 사실을 개별 티켓·화면·모듈
이름 대신 누구나 아는 보편 상황으로 서술하도록 지시한다. 같은 자리에
"프레이밍만 올리고 사건을 더하지 않는다" 경계를 명시해 보편화가
지어내기로 번지지 않게 막는다.

Refs: UNC-248
🤖 Generated with Routine B (Uncommitted Builder v2)
EOF
)"
```

---

### Task 3 (UNC-249): 반어(deadpan) 프레임 규칙을 두 프롬프트에 주입

**Files:**
- Modify: `src/diary-generator.ts` (상수 추가 + 두 빌더 함수)
- Test: `tests/diary-generator.test.ts`

**Interfaces:**
- Consumes: Task 2가 만든 `ALTITUDE_RULE_LINES` 상수 패턴 (같은 자리, 같은 스타일로 옆에 추가)
- Produces: 모듈 스코프 상수 `const DEADPAN_FRAME_LINES: readonly string[]`

**규칙 문구 (정확히 이 문자열):**

```ts
const DEADPAN_FRAME_LINES = [
  "Deadpan frame: deliver the universal framing straight-faced, as if stating sincere advice or an obvious truth. The humor comes from the gap between the calm delivery and the actual situation.",
  "Never signal that you are joking: no winking, no explaining the bit, no exclamation-stacked punchlines.",
  "The deadpan frame targets situations, tools, and workflows only. It never becomes irony aimed at the user's identity, ability, appearance, mental health, personal value, or real life."
] as const;
```

세 번째 줄이 중요하다 — 부모 AC2의 "사람을 향하지 않는다는 기존 제약이 유지된다"를 반어 규칙 **안에서도** 다시 못 박는다. 기존 roast 경계 줄들(`"Never attack the user's identity, ability, appearance, mental health, personal value, or real life."`)은 **삭제하거나 약화시키지 않는다.**

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/diary-generator.test.ts`의 caption generator describe 블록에 Task 2 테스트 다음으로 추가:

```ts
  it("buildCaptionInstructions carries the deadpan frame without weakening the human boundary (UNC-249)", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(instructions).toContain("Deadpan frame: deliver the universal framing straight-faced");
    expect(instructions).toContain("Never signal that you are joking");
    expect(instructions).toContain(
      "It never becomes irony aimed at the user's identity, ability, appearance, mental health, personal value, or real life"
    );
    // 기존 로스트 경계가 그대로 남아 있어야 한다
    expect(instructions).toContain(
      "Never insult ability, worth, personality, identity, mental health, or real life"
    );
  });
```

diary generator describe 블록에 Task 2 테스트 다음으로 추가:

```ts
  it("diary instructions carry the deadpan frame without weakening the human boundary (UNC-249)", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft()
    });

    await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 4 }),
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("Deadpan frame: deliver the universal framing straight-faced");
    expect(instructions).toContain("Never signal that you are joking");
    expect(instructions).toContain(
      "It never becomes irony aimed at the user's identity, ability, appearance, mental health, personal value, or real life"
    );
    // 기존 로스트 경계가 그대로 남아 있어야 한다
    expect(instructions).toContain(
      "Never attack the user's identity, ability, appearance, mental health, personal value, or real life"
    );
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run:
```bash
pnpm vitest run tests/diary-generator.test.ts -t "UNC-249"
```
Expected: FAIL — deadpan 문자열이 없어서 `toContain` 실패. (마지막 "기존 경계" 단언은 이미 통과하는 상태여야 정상이다.)

- [ ] **Step 3: 최소 구현**

`src/diary-generator.ts`에서 `ALTITUDE_RULE_LINES` 정의 바로 뒤에 추가:

```ts
/**
 * 반어(deadpan) 프레임 규칙 (UNC-249). 고도 규칙이 만든 보편 프레이밍을
 * "딱 잘라 진지하게" 전달하는 어조 기법이다. roastLevel과 직교하며 기존
 * roast 경계를 대체하지 않는다 — 세 번째 줄이 사람을 향한 반어를 명시적으로
 * 막는다.
 */
const DEADPAN_FRAME_LINES = [
  "Deadpan frame: deliver the universal framing straight-faced, as if stating sincere advice or an obvious truth. The humor comes from the gap between the calm delivery and the actual situation.",
  "Never signal that you are joking: no winking, no explaining the bit, no exclamation-stacked punchlines.",
  "The deadpan frame targets situations, tools, and workflows only. It never becomes irony aimed at the user's identity, ability, appearance, mental health, personal value, or real life."
] as const;
```

`buildDiaryInstructions()`의 반환 배열에서 Task 2가 넣은 `...ALTITUDE_RULE_LINES,` 바로 뒤에 `...DEADPAN_FRAME_LINES,` 를 삽입한다.

`buildCaptionInstructions()`의 반환 배열에서도 Task 2가 넣은 `...ALTITUDE_RULE_LINES,` 바로 뒤에 `...DEADPAN_FRAME_LINES,` 를 삽입한다.

기존 roast 경계 줄들은 그대로 둔다 — 삭제·수정 금지.

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run:
```bash
pnpm vitest run tests/diary-generator.test.ts -t "UNC-249"
```
Expected: PASS (2 passed)

- [ ] **Step 5: 전체 검증**

Run:
```bash
pnpm test && pnpm lint && pnpm typecheck
```
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add src/diary-generator.ts tests/diary-generator.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(diary-generator): add the deadpan frame rule to both prompts

보편 프레이밍을 딱 잘라 진지하게 전달하고 농담이라는 티를 내지 않도록
지시한다. 반어의 대상은 상황·도구·워크플로우로 한정하고, 사람을 향하지
않는다는 기존 경계를 반어 규칙 안에서도 다시 명시한다. 기존 roast 경계
문구는 그대로 유지한다.

Refs: UNC-249
🤖 Generated with Routine B (Uncommitted Builder v2)
EOF
)"
```

---

### Task 4 (UNC-250): 영어 명사구 억제 확대 + 내부 식별자 정책 반영

**의존:** Task 1 (정책 결정), Task 2 (상수 패턴).

**Files:**
- Modify: `src/diary-generator.ts` (상수 추가 + 두 빌더 함수 + `buildCaptionInstructions()` 안의 기존 좁은 규칙 2줄 확대)
- Test: `tests/diary-generator.test.ts`

**Interfaces:**
- Consumes: Task 1의 정책 결정 = **(a) 전면 마스킹** — 티켓 키·내부 화면/모듈/클래스/파일 이름은 출력하지 않고 보편 상황 서술로 바꾼다. 통용 약어·공개 도구명·해시태그는 예외.
- Produces: 모듈 스코프 상수 `const KOREAN_SURFACE_LINES: readonly string[]`

**규칙 문구 (정확히 이 문자열):**

```ts
const KOREAN_SURFACE_LINES = [
  "Write the surface in Korean. Any English noun phrase that has a natural Korean equivalent must be written in Korean instead — for example \"working tree\", \"fire-and-forget\", \"boundary tape\", \"release-shaped moment\" should be expressed as Korean, not printed in English.",
  "Exceptions: hashtag tokens (anything starting with #) may stay in English, and widely used abbreviations may stay as-is: CI, PR, API, UI, AI, JSON, URL. Public tool, language, and platform names such as Git, TypeScript, or Instagram are also allowed.",
  "Internal identifiers must never appear: ticket keys such as UNC-123, and internal screen, module, class, or file names such as FeedbackModal or diary-generator.ts. Reframe them as the universal situation they describe instead of masking them with placeholder text."
] as const;
```

**기존 좁은 규칙 2줄의 확대 (원본을 지우지 말고 문구를 넓힌다):**

`buildCaptionInstructions()` 안의 기존 줄
```ts
    "Translate developer jargon (PR numbers, version tags, module or file names, commit hashes) into human stakes — what it actually meant for a person — instead of printing the raw term. Example: an \"archive-context PR\" becomes \"뒤로가기 버튼을 못 믿는 하루\", not the literal PR name. Someone who has never touched this project should still be able to read the caption and relate to it.",
```
을 아래로 **교체**한다 (대상을 "developer jargon" → "developer jargon and any project-internal English noun phrase"로 넓힘):
```ts
    "Translate developer jargon and any project-internal English noun phrase (PR numbers, version tags, module or file names, commit hashes, internal screen names) into human stakes — what it actually meant for a person — instead of printing the raw term. Example: an \"archive-context PR\" becomes \"뒤로가기 버튼을 못 믿는 하루\", not the literal PR name. Someone who has never touched this project should still be able to read the caption and relate to it.",
```

같은 함수의 `=== RULES ===` 절에 있는 기존 줄
```ts
    "Do not leave raw jargon such as PR numbers, version tags, or module/file names in the caption unless it carries human meaning — translate it into what it meant for a person instead.",
```
을 아래로 **교체**한다:
```ts
    "Do not leave raw jargon or untranslated English noun phrases such as PR numbers, version tags, module/file names, or internal screen names in the caption — translate each into what it meant for a person instead.",
```

- [ ] **Step 1: 실패하는 테스트를 쓴다**

caption generator describe 블록에 Task 3 테스트 다음으로 추가:

```ts
  it("buildCaptionInstructions widens English suppression and carries the internal-identifier policy (UNC-250)", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    // 일반 영어 명사구 억제로 확대
    expect(instructions).toContain("Write the surface in Korean");
    expect(instructions).toContain("English noun phrase that has a natural Korean equivalent");
    expect(instructions).toContain("working tree");
    expect(instructions).toContain("fire-and-forget");

    // 해시태그·통용 약어 예외 명시
    expect(instructions).toContain("hashtag tokens (anything starting with #) may stay in English");
    expect(instructions).toContain("CI, PR, API, UI, AI, JSON, URL");

    // 내부 식별자 전면 마스킹 정책 (UNC-247 결정)
    expect(instructions).toContain("Internal identifiers must never appear");
    expect(instructions).toContain("ticket keys such as UNC-123");
    expect(instructions).toContain("FeedbackModal");

    // 기존 좁은 규칙이 넓혀진 형태로 남아 있다
    expect(instructions).toContain(
      "Translate developer jargon and any project-internal English noun phrase"
    );
    expect(instructions).toContain(
      "Do not leave raw jargon or untranslated English noun phrases"
    );
  });
```

diary generator describe 블록에 Task 3 테스트 다음으로 추가 (카드 슬롯 쪽에는 동등 규칙이 **신설**된다):

```ts
  it("diary instructions gain the Korean-surface rule and the internal-identifier policy (UNC-250)", async () => {
    const provider = new MockAiProvider({
      response: createProviderDraft()
    });

    await generateDiaryDraft({
      activitySummary: createActivitySummary(),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 4 }),
      provider,
      persona: "wry coworker",
      roastLevel: 2
    });

    const instructions = provider.requests[0]?.instructions ?? "";
    expect(instructions).toContain("Write the surface in Korean");
    expect(instructions).toContain("hashtag tokens (anything starting with #) may stay in English");
    expect(instructions).toContain("CI, PR, API, UI, AI, JSON, URL");
    expect(instructions).toContain("Internal identifiers must never appear");
    expect(instructions).toContain("ticket keys such as UNC-123");
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run:
```bash
pnpm vitest run tests/diary-generator.test.ts -t "UNC-250"
```
Expected: FAIL — 두 테스트 모두 `toContain` 실패

- [ ] **Step 3: 최소 구현**

`src/diary-generator.ts`에서 `DEADPAN_FRAME_LINES` 정의 바로 뒤에 `KOREAN_SURFACE_LINES` 상수를 추가한다 (위 "규칙 문구" 그대로). JSDoc에 정책 문서 경로를 남긴다:

```ts
/**
 * 영어 명사구 억제 + 내부 식별자 정책 (UNC-250). 내부 식별자 처리는
 * docs/superpowers/specs/2026-08-07-unc-247-internal-identifier-exposure-policy.md
 * 에서 결정한 (a) 전면 마스킹을 따른다 — 마스킹 placeholder를 찍는 게 아니라
 * 보편 상황 서술로 바꾸는 것이다.
 */
```

`buildDiaryInstructions()`의 반환 배열에서 `...DEADPAN_FRAME_LINES,` 바로 뒤에 `...KOREAN_SURFACE_LINES,` 를 삽입한다.

`buildCaptionInstructions()`의 반환 배열에서도 `...DEADPAN_FRAME_LINES,` 바로 뒤에 `...KOREAN_SURFACE_LINES,` 를 삽입하고, 위 "기존 좁은 규칙 2줄의 확대"에 적힌 두 줄 교체를 수행한다.

- [ ] **Step 4: 테스트가 통과하는지 확인**

Run:
```bash
pnpm vitest run tests/diary-generator.test.ts -t "UNC-250"
```
Expected: PASS (2 passed)

- [ ] **Step 5: 전체 검증**

Run:
```bash
pnpm test && pnpm lint && pnpm typecheck
```
Expected: 전부 PASS. 기존 캡션 테스트 중 교체한 두 줄의 옛 문구를 `toContain` 으로 검사하는 것이 있으면, 그 테스트를 **읽고** 새 문구로 갱신한다 (단언 자체를 삭제하지 말고 확대된 문구에 맞게 고친다).

- [ ] **Step 6: 커밋**

```bash
git add src/diary-generator.ts tests/diary-generator.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(diary-generator): widen English suppression and apply the identifier policy

캡션의 좁은 전문용어 번역 규칙(PR 번호·버전 태그·모듈명 한정)을 한국어로
번역 가능한 일반 영어 명사구 전반으로 넓히고, 카드 슬롯 프롬프트에도 같은
취지의 규칙을 신설한다. 해시태그와 통용 약어(CI, PR, API 등), 공개 도구명은
예외. 내부 식별자는 UNC-247이 결정한 전면 마스킹 정책에 따라 출력하지 않고
보편 상황 서술로 바꾸도록 지시한다.

Refs: UNC-250
🤖 Generated with Routine B (Uncommitted Builder v2)
EOF
)"
```

---

### Task 5 (UNC-251): 조용한 날 정직성 회귀 테스트

**의존:** Task 2, Task 3 (두 규칙이 프롬프트에 들어간 뒤라야 상호작용을 검증할 수 있다).

이 태스크는 **테스트만** 추가한다. `assertQuietDayHonesty` / `assertCaptionQuietDayHonesty`의 검출 로직을 재설계하지 않는다. 목적은 "고도·반어 규칙이 붙은 뒤에도 조용한 날 지어내기가 여전히 거부된다"를 못 박는 것이다.

**Files:**
- Test: `tests/diary-generator.test.ts`

**Interfaces:**
- Consumes: `generateDiaryDraft`, `generateCaption`, `MockAiProvider`, 테스트 헬퍼 `createActivitySummary`, `createProviderDraft`, `createStoryFormatPlan`, 상수 `captionTestPersona`, `captionTestMoodPlan` — 전부 이미 파일에 존재한다.
- Produces: 없음

**검출 로직 참고 (구현하지 말고 이해만 할 것):** `assertQuietDayHonesty`와 `assertCaptionQuietDayHonesty`는 `activityLevel === "none"` 일 때만 동작하고, 정규식 `/\b(?:\d+\s+commits?|fixed|implemented|shipped|built|released|merged|debugged)\b/i` 로 지어내기를 검출한다. 따라서 회귀 케이스의 프로바이더 출력에는 이 토큰 중 하나가 **보편 프레이밍/반어 어조로 포장된 채** 들어 있어야 하고, 통과 케이스에는 하나도 들어 있으면 안 된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — 카드 슬롯 쪽 (거부)**

`tests/diary-generator.test.ts`의 diary generator describe 블록, Task 4 테스트 다음에 추가:

```ts
  it("still rejects quiet-day fabrication dressed up as universal framing (UNC-251)", async () => {
    await expect(
      generateDiaryDraft({
        activitySummary: createActivitySummary({
          activityLevel: "none",
          dominantTheme: "quiet",
          projects: [],
          commitSignals: {
            totalCommits: 0,
            filesChanged: 0,
            insertions: 0,
            deletions: 0,
            subjects: [],
            themes: []
          },
          smallWins: [],
          unfinishedThreads: []
        }),
        storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
        provider: new MockAiProvider({
          response: createProviderDraft({
            slides: [
              {
                index: 1,
                title: "좋은 협업 팁 ①",
                body: "누구나 아는 그 순간이 왔습니다. 오늘도 조용히 3 commits 를 밀어 넣는 하루.",
                visualMood: "still terminal"
              },
              {
                index: 2,
                title: "보편적인 오후",
                body: "모두가 겪는 일입니다. 아무 말 없이 버그가 fixed 되어 있는 오후 말입니다.",
                visualMood: "waiting cursor"
              },
              {
                index: 3,
                title: "마무리",
                body: "내일의 기록을 기다리는 쪽으로 닫았다.",
                visualMood: "small note"
              }
            ]
          })
        }),
        persona: "wry coworker",
        roastLevel: 2
      })
    ).rejects.toMatchObject({
      code: "malformed-response",
      message: "AI provider fabricated quiet-day activity."
    });
  });
```

- [ ] **Step 2: 실패하는 테스트를 쓴다 — 카드 슬롯 쪽 (통과)**

바로 위 테스트 다음에 추가. 보편 프레이밍 + 반어 어조 자체는 조용한 날에도 **허용**되어야 한다는 반대편 케이스다.

```ts
  it("accepts a quiet day framed universally when no work is claimed (UNC-251)", async () => {
    const draft = await generateDiaryDraft({
      activitySummary: createActivitySummary({
        activityLevel: "none",
        dominantTheme: "quiet",
        projects: [],
        commitSignals: {
          totalCommits: 0,
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
          subjects: [],
          themes: []
        },
        smallWins: [],
        unfinishedThreads: []
      }),
      storyFormatPlan: createStoryFormatPlan({ suggestedSlideCount: 3 }),
      provider: new MockAiProvider({
        response: createProviderDraft({
          slides: [
            {
              index: 1,
              title: "좋은 생산성 팁 ①",
              body: "아무것도 기록되지 않은 날을 가지세요. 기록할 게 없다는 것도 하루의 모양입니다.",
              visualMood: "still terminal"
            },
            {
              index: 2,
              title: "기다림",
              body: "누구에게나 있는 그 하루. 커서만 깜빡이고 아무 일도 일어나지 않았습니다.",
              visualMood: "waiting cursor"
            },
            {
              index: 3,
              title: "마무리",
              body: "내일의 기록을 기다리는 쪽으로 닫았습니다.",
              visualMood: "small note"
            }
          ]
        })
      }),
      persona: "wry coworker",
      roastLevel: 2
    });

    expect(draft.metadata.activityLevel).toBe("none");
    expect(draft.slides).toHaveLength(3);
  });
```

- [ ] **Step 3: 실패하는 테스트를 쓴다 — 캡션 쪽 (거부 + 통과)**

caption generator describe 블록, Task 4 테스트 다음에 추가:

```ts
  it("still rejects a quiet-day caption that hides fabrication behind universal framing (UNC-251)", async () => {
    const quietSummary = createActivitySummary({
      activityLevel: "none",
      dominantTheme: "quiet",
      projects: [],
      commitSignals: {
        totalCommits: 0,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        subjects: [],
        themes: []
      },
      smallWins: [],
      unfinishedThreads: []
    });

    await expect(
      generateCaption({
        activitySummary: quietSummary,
        provider: new MockAiProvider({
          response: {
            caption:
              "좋은 하루 관리 팁 ①\n\n누구나 겪는 그 오후에\n버그 하나를 조용히 fixed 해두세요.\n\n아무도 모르게요.",
            hashtags: ["#Uncommitted", "#개발일기"]
          }
        }),
        persona: captionTestPersona,
        roastLevel: 2,
        moodPlan: captionTestMoodPlan
      })
    ).rejects.toMatchObject({
      code: "malformed-response",
      message: "AI provider fabricated quiet-day activity in caption."
    });
  });

  it("accepts a quiet-day caption that stays universal without claiming work (UNC-251)", async () => {
    const quietSummary = createActivitySummary({
      activityLevel: "none",
      dominantTheme: "quiet",
      projects: [],
      commitSignals: {
        totalCommits: 0,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        subjects: [],
        themes: []
      },
      smallWins: [],
      unfinishedThreads: []
    });

    const result = await generateCaption({
      activitySummary: quietSummary,
      provider: new MockAiProvider({
        response: {
          caption:
            "좋은 생산성 팁 ①\n\n오늘은 아무것도 남기지 마세요.\n기록이 없는 날도 하루의 모양입니다.\n\n저는 옆에서 커서만 봤습니다.",
          hashtags: ["#Uncommitted", "#개발일기"]
        }
      }),
      persona: captionTestPersona,
      roastLevel: 2,
      moodPlan: captionTestMoodPlan
    });

    expect(result.caption).toContain("기록이 없는 날");
    expect(result.hashtags).toHaveLength(2);
  });
```

- [ ] **Step 4: 테스트를 실행한다**

Run:
```bash
pnpm vitest run tests/diary-generator.test.ts -t "UNC-251"
```
Expected: 4개 모두 PASS.

이 태스크는 회귀 테스트이므로 **처음부터 통과하는 것이 정상이다** — 기존 검출 로직이 새 프롬프트 규칙에도 여전히 유효하다는 것을 증명하는 게 목적이다. 만약 "거부" 케이스가 통과하지 않고 draft/caption이 그냥 반환된다면, 그것은 진짜 회귀다: 그 경우 검출 로직을 재설계하지 말고 **BLOCKED로 보고**하라 (이 태스크의 범위는 테스트 추가로 한정되어 있다). 만약 "통과" 케이스가 거부된다면 테스트 픽스처 문장에 검출 정규식 토큰(`fixed`, `built`, `merged`, `shipped`, `released`, `implemented`, `debugged`, `N commits`)이 섞였다는 뜻이니 픽스처 문장을 고쳐라.

- [ ] **Step 5: 전체 검증**

Run:
```bash
pnpm test && pnpm lint && pnpm typecheck && pnpm build
```
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add tests/diary-generator.test.ts
git commit -m "$(cat <<'EOF'
✅ test(diary-generator): guard quiet-day honesty against universal framing

고도·반어 규칙이 프롬프트에 들어간 뒤에도, 보편 서술과 딱 잘라 진지한
어조로 포장된 지어내기가 조용한 날 정직성 검사에 여전히 걸리는지 확인한다.
슬라이드·캡션 양쪽에 거부 케이스와, 작업을 주장하지 않는 보편 서술은
그대로 통과하는 케이스를 함께 넣었다.

Refs: UNC-251
🤖 Generated with Routine B (Uncommitted Builder v2)
EOF
)"
```

---

## Self-Review

**1. Spec coverage** — 부모 UNC-234의 AC 5개 대응:

| 부모 AC | 담당 태스크 |
| --- | --- |
| 1. 고도 규칙 + "사실 유지 / 없는 일 금지" 명시 (단위 테스트) | Task 2 |
| 2. 반어 프레임 규칙 + 사람 향하지 않음 유지 (단위 테스트) | Task 3 |
| 3. 영어 명사구 억제 + 해시태그·통용 약어 예외 (단위 테스트) | Task 4 |
| 4. 내부 식별자 정책 결정·문서화 + 프롬프트 반영 | Task 1 (결정·문서) + Task 4 (프롬프트) |
| 5. 조용한 날 드라마화 방지 유지 (회귀 테스트) | Task 5 |

부모 Scope 4항목도 전부 커버된다. Out of Scope(사실 변경, 카드 종류·렌더, 해시태그 생성 규칙)는 어떤 태스크도 건드리지 않는다.

**2. Placeholder scan** — 모든 규칙 문구가 리터럴로 적혀 있고, 모든 테스트가 실제 코드 블록으로 제시되어 있다. "TBD"·"적절히 처리"·"Task N과 유사" 없음.

**3. Type consistency** — 상수 이름 3개(`ALTITUDE_RULE_LINES`, `DEADPAN_FRAME_LINES`, `KOREAN_SURFACE_LINES`)가 정의 태스크와 참조 태스크에서 동일하다. 테스트 헬퍼 이름(`createActivitySummary`, `createProviderDraft`, `createStoryFormatPlan`, `captionTestPersona`, `captionTestMoodPlan`)은 모두 기존 파일에 존재하는 실제 식별자다. `generateCaption` 호출 시그니처(`activitySummary`/`provider`/`persona`/`roastLevel`/`moodPlan`)는 기존 테스트 사용례와 일치한다.
