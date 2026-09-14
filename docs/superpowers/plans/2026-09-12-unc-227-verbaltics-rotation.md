# UNC-227 말버릇 고착 — verbalTics 로테이션과 캡션 문구 반복 회피 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 추임새(verbalTic)와 같은 마무리 줄이 며칠 연속 반복되지 않도록, 실제로 쓴 캡션 표층 문구를 format history에 남기고 다음 날 캡션 지시문이 그것을 피하게 한다.

**Architecture:** `formats.json` 엔트리에 optional `captionSurface { usedTics, landingLine? }` 필드를 추가해 기록한다(T1). 캡션 지시문 계층(`buildCaptionInstructions`)이 `captionHistory { targetDate, recentFormats }` 옵션을 받아 최근 3일 윈도의 기록으로 signature phrases를 회전(T2)하고 최근 마무리 줄 회피 블록을 붙인다(T3). 프리셋 tic 풀을 넓혀 로테이션이 실제로 관측되게 한다(T4).

**Tech Stack:** TypeScript (ESM, `.js` import 확장자), Node ≥22.13, pnpm, vitest, ESLint.

**Spec:** Linear UNC-227 (부모) + UNC-280 (T1) / UNC-281 (T2) / UNC-282 (T3) / UNC-283 (T4). 핵심 결정: N=3, 풀 소진 시 가장 오래 전에 쓴 tic 1개 부활, tic 사용 판정은 최종 캡션 문자열에 대한 사후 부분일치(프로바이더 응답 스키마 변경 없음), 날짜당 1레코드 유지, 저장 전 `sanitizeText` 적용.

## Global Constraints

- 작업 디렉터리는 **`../uncommitted-UNC-227`** (브랜치 `claude/UNC-227-verbaltics-rotation`) 한 곳뿐. `using-git-worktrees` 실행 금지, main 체크아웃·새 worktree 작업 금지.
- 수정 금지 파일: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `.env*`, `**/secrets/*`, `**/credentials/*`, `AGENTS.md`, `CLAUDE.md`.
- 새 의존성 추가 금지. 자동 publish(SNS 업로드) 코드 추가 금지. macOS-first 유지.
- 테스트는 vitest (`pnpm vitest run <file>`), 전체 검증은 `pnpm check` (lint → typecheck → test → build).
- 공개 산출물/히스토리에 secret·경로·이메일·private URL·raw code가 남으면 안 된다 — 히스토리에 넣는 캡션 문구는 반드시 `sanitizeText`(`src/redaction.ts`)를 통과시킨다.
- 프로바이더(story-plan) 입력 `input.recentFormats`는 **바이트 단위로 이전과 동일**해야 한다 (신규 필드를 story-plan 프로바이더로 보내지 않는다).
- 히스토리가 비어 있거나 `captionSurface`가 없는 날의 캡션 지시문은 **이전과 문자열 단위로 동일**해야 한다 (부모 AC5).
- 커밋 규약: 제목 `<gitmoji> type(scope): 한국어 요약 (UNC-<sub>)`, 본문 1~3줄, 푸터:
  ```
  Refs: UNC-<sub>
  🤖 Generated with Routine B (Uncommitted Builder v2)

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
  push 하지 않는다(오케스트레이터가 한다).

## File Structure

- `src/story-format-plan.ts` — (T1) `CaptionSurface` 타입, `RecentStoryFormat.captionSurface`, `extractCaptionSurface`, projection/record 확장, story-plan 입력 projection.
- `src/generate-command.ts` — (T1) record에 caption/verbalTics 전달, (T2) `generateCaption`에 `recentFormats` 전달. 로직 없음.
- `src/diary-generator.ts` — (T2) `CAPTION_REPETITION_WINDOW_DAYS`, `CaptionHistoryContext`, `selectCaptionHistoryWindow`, `selectRotatedVerbalTics`, `buildPersonaCaptionLines`/`buildCaptionInstructions`/`generateCaption` 확장. (T3) `buildRecentLandingLineAvoidanceLines`.
- `src/persona.ts` — (T4) 프리셋 `verbalTics` 추가.
- Tests: `tests/story-format-plan.test.ts`, `tests/generate-command.test.ts`, `tests/diary-generator.test.ts`, `tests/persona.test.ts`.

---

### Task 1 (UNC-280): formats.json에 최근 캡션 표층 문구(사용 tic + 마무리 줄) 저장

**Files:**
- Modify: `src/story-format-plan.ts` (types ~117-154, `recordStoryFormatHistory` 247-279, `buildSafeStoryFormatInput` 281-339, `pickRecentStoryFormatFields` 455-473)
- Modify: `src/generate-command.ts:734-738`
- Test: `tests/story-format-plan.test.ts`, `tests/generate-command.test.ts`

**Interfaces:**
- Produces (later tasks rely on these exact names):
  ```ts
  export type CaptionSurface = {
    /** persona verbalTics (원문 그대로) 중 최종 캡션에 실제로 나타난 것. */
    usedTics: string[];
    /** 캡션의 마지막 비어있지 않은 비-해시태그 줄. 없으면 생략. */
    landingLine?: string;
  };
  export type RecentStoryFormat = {
    date: string;
    mood?: Mood;
    angle?: string;
    formatName?: string;
    captionSurface?: CaptionSurface;
  };
  export function extractCaptionSurface(caption: string, verbalTics: readonly string[]): CaptionSurface;
  // RecordStoryFormatHistoryOptions gains: caption?: string; verbalTics?: readonly string[];
  ```

**소스 대조로 확인된 사실 (이슈 본문 정정):**
- `src/generate-command.ts:595`의 `caption`은 `deriveCaptionText`(`src/diary-generator.ts:167`) 결과라 **마지막 줄이 해시태그 줄**(`#Uncommitted #개발일기`)이다. 이슈의 "마지막 비어있지 않은 줄" 정의를 그대로 쓰면 매일 해시태그 줄이 저장된다. → **마무리 줄 = 마지막 비어있지 않은 줄 중 해시태그 전용 줄(공백 구분 토큰이 전부 `#`로 시작)이 아닌 것.**
- `loadRecentStoryFormatHistory` 결과는 story-plan 프로바이더 입력(`buildSafeStoryFormatInput` → `recentFormats`)으로도 간다. 신규 필드를 그대로 흘리면 story-plan 프로바이더 입력이 바뀌고 `tests/generate-command.test.ts` "records generated story formats so later drafts can vary genre"의 `toEqual`이 깨진다. → story-plan 입력에서는 `captionSurface`를 벗겨낸다.
- `isRecentStoryFormat`의 엔트리 수용 기준(mood 또는 formatName 필요)은 바꾸지 않는다. 형식이 잘못된 `captionSurface`는 **엔트리를 버리지 않고 필드만 버린다**(projection에서 검증).

- [ ] **Step 1: Write the failing tests** — append to `tests/story-format-plan.test.ts` (add `extractCaptionSurface` to the existing import from `../src/story-format-plan.js`):

```ts
describe("caption surface history (UNC-280)", () => {
  it("extracts used tics by substring match and the last non-hashtag line as the landing line", () => {
    const surface = extractCaptionSurface(
      "오늘은 테스트가 먼저 넘어졌다. 그렇군..\n\n그래도 저녁엔 초록불이었음.\n\n#Uncommitted #개발일기\n",
      ["...음.", "그렇군."]
    );

    expect(surface).toEqual({
      usedTics: ["그렇군."],
      landingLine: "그래도 저녁엔 초록불이었음."
    });
  });

  it("does not treat a tic's bare last syllable inside an ordinary word as usage", () => {
    expect(extractCaptionSurface("오늘은 조용했음.", ["...음."]).usedTics).toEqual([]);
    expect(extractCaptionSurface("…음. 조용했음.", ["...음."]).usedTics).toEqual(["...음."]);
  });

  it("uses the whole line as the landing line for a one-line caption and omits it when only hashtags remain", () => {
    expect(extractCaptionSurface("한 줄짜리 캡션.", [])).toEqual({
      usedTics: [],
      landingLine: "한 줄짜리 캡션."
    });
    expect(extractCaptionSurface("#Uncommitted #개발일기\n", [])).toEqual({
      usedTics: []
    });
  });

  it("sanitizes the landing line before it is stored", () => {
    const surface = extractCaptionSurface(
      "마지막 줄에 me@example.com 과 /Users/me/secret 이 섞였다.",
      []
    );

    expect(surface.landingLine).not.toContain("me@example.com");
    expect(surface.landingLine).not.toContain("/Users/me/secret");
    expect(surface.landingLine).toContain("[redacted-email]");
  });

  it("round-trips captionSurface through recordStoryFormatHistory and loadRecentStoryFormatHistory", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-history-"));

    await recordStoryFormatHistory({
      homeDir,
      targetDate: "2026-05-12",
      storyFormatPlan: createMoodPlan({ mood: "grind", angle: "slow tests" }),
      caption: "테스트가 느렸다. ...음.\n\n내일은 조금 빠르길.\n\n#Uncommitted\n",
      verbalTics: ["...음.", "그렇군."]
    });

    const recent = await loadRecentStoryFormatHistory({ homeDir });

    expect(recent).toEqual([
      {
        date: "2026-05-12",
        mood: "grind",
        angle: "slow tests",
        captionSurface: { usedTics: ["...음."], landingLine: "내일은 조금 빠르길." }
      }
    ]);
  });

  it("does not write captionSurface when no caption is given (existing record shape unchanged)", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-history-"));

    await recordStoryFormatHistory({
      homeDir,
      targetDate: "2026-05-12",
      storyFormatPlan: createMoodPlan({ mood: "firefight", angle: "flaky retry handling" })
    });

    const raw = JSON.parse(
      await readFile(join(homeDir, ".uncommitted", "history", "formats.json"), "utf8")
    ) as { formats: Record<string, unknown>[] };

    expect(raw.formats[0]).toEqual({
      date: "2026-05-12",
      mood: "firefight",
      angle: "flaky retry handling"
    });
  });

  it("loads a pre-existing formats.json without captionSurface without error (backward compat)", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-history-"));
    const historyDir = join(homeDir, ".uncommitted", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "formats.json"),
      JSON.stringify({
        schemaVersion: 1,
        formats: [
          { date: "2026-05-11", mood: "grind", angle: "slow test suite" },
          { date: "2026-05-10", formatName: "quiet" }
        ]
      }),
      "utf8"
    );

    const recent = await loadRecentStoryFormatHistory({ homeDir });

    expect(recent).toEqual([
      { date: "2026-05-11", mood: "grind", angle: "slow test suite" },
      { date: "2026-05-10", formatName: "quiet", mood: "quiet" }
    ]);
  });

  it("keeps the entry but drops a malformed captionSurface on load", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-history-"));
    const historyDir = join(homeDir, ".uncommitted", "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "formats.json"),
      JSON.stringify({
        schemaVersion: 1,
        formats: [
          { date: "2026-05-11", mood: "grind", captionSurface: { usedTics: "그렇군." } }
        ]
      }),
      "utf8"
    );

    const recent = await loadRecentStoryFormatHistory({ homeDir });

    expect(recent).toEqual([{ date: "2026-05-11", mood: "grind" }]);
  });

  it("preserves captionSurface of older entries when a new day is recorded", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "uncommitted-history-"));

    await recordStoryFormatHistory({
      homeDir,
      targetDate: "2026-05-11",
      storyFormatPlan: createMoodPlan({ mood: "grind", angle: "a" }),
      caption: "그렇군.\n어제의 마무리.",
      verbalTics: ["그렇군."]
    });
    await recordStoryFormatHistory({
      homeDir,
      targetDate: "2026-05-12",
      storyFormatPlan: createMoodPlan({ mood: "cleanup", angle: "b" })
    });

    const recent = await loadRecentStoryFormatHistory({ homeDir });

    expect(recent[1]).toEqual({
      date: "2026-05-11",
      mood: "grind",
      angle: "a",
      captionSurface: { usedTics: ["그렇군."], landingLine: "어제의 마무리." }
    });
  });

  it("does not send captionSurface to the story-plan provider", async () => {
    const provider = new MockAiProvider({
      response: createMoodProviderPlan({ mood: "grind" })
    });

    await generateStoryFormatPlan({
      activitySummary: createActivitySummary(),
      provider,
      persona: "wry coworker",
      roastLevel: 2,
      recentFormats: [
        {
          date: "2026-05-11",
          mood: "grind",
          angle: "a",
          captionSurface: { usedTics: ["그렇군."], landingLine: "어제의 마무리." }
        }
      ]
    });

    expect(
      (provider.requests[0] as { input: { recentFormats: unknown } }).input.recentFormats
    ).toEqual([{ date: "2026-05-11", mood: "grind", angle: "a" }]);
  });
});
```

Note: `createMoodPlan`, `createMoodProviderPlan`, `createActivitySummary` are existing helpers at the bottom of `tests/story-format-plan.test.ts` — reuse them; check their signatures before use.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/story-format-plan.test.ts`
Expected: FAIL — `extractCaptionSurface` is not exported / `captionSurface` missing.

- [ ] **Step 3: Implement in `src/story-format-plan.ts`**

Add import: `import { sanitizeText } from "./redaction.js";`

Types (replace `RecentStoryFormat`, extend `RecordStoryFormatHistoryOptions`):

```ts
/**
 * UNC-280: 그날 최종 캡션에서 실제로 쓰인 표층 문구. 캡션 전문이 아니라
 * 짧은 추출물만 남겨 히스토리 비대화를 막는다. 다음 날 캡션 지시문이 최근
 * 쓴 tic·마무리 줄을 피하는 근거가 된다 (UNC-281/282).
 */
export type CaptionSurface = {
  usedTics: string[];
  landingLine?: string;
};

export type RecentStoryFormat = {
  date: string;
  mood?: Mood;
  angle?: string;
  /** (existing formatName doc comment stays) */
  formatName?: string;
  captionSurface?: CaptionSurface;
};

export type RecordStoryFormatHistoryOptions = {
  homeDir?: string;
  targetDate: string;
  storyFormatPlan: MoodPlan;
  limit?: number;
  /** redaction을 마친 최종 캡션 텍스트. 주면 captionSurface를 함께 기록한다. */
  caption?: string;
  /** 그날 persona의 verbalTics. 사용 여부는 caption에 대한 사후 부분일치로 판정한다. */
  verbalTics?: readonly string[];
};
```

Extraction helper (export):

```ts
/**
 * UNC-280: 캡션 표층 문구 추출.
 * - 마무리 줄: 마지막 비어있지 않은 줄 중 해시태그 전용 줄이 아닌 것.
 *   (저장되는 캡션은 deriveCaptionText 결과라 마지막 줄이 해시태그다.)
 * - 사용 tic: 끝 구두점만 뗀 tic이 캡션에 부분일치하면 사용한 것으로 본다
 *   ("그렇군." ↔ "그렇군.."). 앞쪽 말줄임은 떼지 않는다 — "...음."을 "음"으로
 *   줄이면 "이었음" 같은 어미에도 걸린다. "…"는 "..."로 정규화해 비교한다.
 *   저장은 persona의 tic 원문으로 한다.
 * 저장 전 sanitizeText를 거친다 — 캡션 문구도 히스토리 파일에 남는 데이터다.
 */
export function extractCaptionSurface(
  caption: string,
  verbalTics: readonly string[]
): CaptionSurface {
  const sanitized = sanitizeText(caption).value;
  const comparable = sanitized.replace(/…/gu, "...");
  const usedTics = verbalTics.filter((tic) => {
    const core = tic.replace(/…/gu, "...").trim().replace(/[.!?~,]+$/u, "");

    return core.length > 0 && comparable.includes(core);
  });
  const landingLine = sanitized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isHashtagOnlyLine(line))
    .at(-1);

  return landingLine === undefined ? { usedTics } : { usedTics, landingLine };
}

function isHashtagOnlyLine(line: string): boolean {
  return line.split(/\s+/u).every((token) => token.startsWith("#"));
}
```

`recordStoryFormatHistory`: build `nextFormat` then attach surface only when `options.caption !== undefined`:

```ts
  const nextFormat: RecentStoryFormat = {
    date: options.targetDate,
    mood: options.storyFormatPlan.mood,
    angle: options.storyFormatPlan.angle
  };

  if (options.caption !== undefined) {
    nextFormat.captionSurface = extractCaptionSurface(
      options.caption,
      options.verbalTics ?? []
    );
  }
```
(dedupe key `date + mood + angle` unchanged.)

`pickRecentStoryFormatFields`: after `formatName`, add

```ts
  if (isCaptionSurface(entry.captionSurface)) {
    recent.captionSurface = {
      usedTics: [...entry.captionSurface.usedTics],
      ...(entry.captionSurface.landingLine !== undefined
        ? { landingLine: entry.captionSurface.landingLine }
        : {})
    };
  }
```
and update that function's doc comment to mention `captionSurface` is projected (UNC-280). Add near `isRecentStoryFormat`:

```ts
function isCaptionSurface(value: unknown): value is CaptionSurface {
  return (
    isRecord(value) &&
    Array.isArray(value.usedTics) &&
    value.usedTics.every((tic) => typeof tic === "string") &&
    (value.landingLine === undefined || typeof value.landingLine === "string")
  );
}
```
Do NOT change `isRecentStoryFormat` acceptance.

`buildSafeStoryFormatInput`: replace `recentFormats: options.recentFormats,` with

```ts
    // UNC-280: captionSurface는 캡션 지시문 전용이다. story-plan 프로바이더
    // 입력은 이전과 동일하게 다양성 키만 싣는다.
    recentFormats: options.recentFormats.map(toStoryPlanRecentFormat),
```
with

```ts
function toStoryPlanRecentFormat(format: RecentStoryFormat): RecentStoryFormat {
  const { captionSurface: _captionSurface, ...diversityKeys } = format;

  return diversityKeys;
}
```
(If ESLint flags the unused `_captionSurface`, build the object explicitly from `date`/`mood`/`angle`/`formatName` instead, omitting undefined keys.) Check that `recentFormats` in `SafeActivitySummary` typing still accepts this (it did before).

- [ ] **Step 4: Run** `pnpm vitest run tests/story-format-plan.test.ts` → PASS.

- [ ] **Step 5: Wiring test in `tests/generate-command.test.ts`** — add right after the test "records generated story formats so later drafts can vary genre", reusing the same fixture helpers (`createIo`, `createRegisteredProjectFixture`, `writeGitEvent`, `TaskAwareProvider`, `createProviderCaption`, `runCli`, `readJson`):

```ts
  it("records the caption's used tics and landing line into formats.json (UNC-280)", async () => {
    const { io, stderr } = createIo();
    const fixture = await createRegisteredProjectFixture();

    await writeGitEvent(fixture.project, "2026-05-12");

    await runCli(["generate", "today"], io, {
      homeDir: fixture.homeDir,
      now: () => "2026-05-12T23:30:00.000Z",
      aiProvider: new TaskAwareProvider({
        caption: createProviderCaption({
          caption: "오늘은 버그 하나를 잡았다. 그렇군.\n내일은 테스트가 먼저 웃겠지."
        })
      })
    });

    const formats = (await readJson(
      join(fixture.homeDir, ".uncommitted", "history", "formats.json")
    )) as { formats: { captionSurface?: unknown }[] };

    expect(stderr).toEqual([]);
    expect(formats.formats[0]?.captionSurface).toEqual({
      usedTics: ["그렇군."],
      landingLine: "내일은 테스트가 먼저 웃겠지."
    });
  });
```
(The fixture config's legacy string persona migrates to the default preset `시니컬한 관찰자`, whose tics include `"그렇군."`. Adjust helper names if they differ — read the neighbouring test first.)

Run: `pnpm vitest run tests/generate-command.test.ts -t "UNC-280"` → FAIL (captionSurface undefined).

- [ ] **Step 6: Wire `src/generate-command.ts:734`**

```ts
  await recordStoryFormatHistory({
    homeDir: options.homeDir,
    targetDate,
    storyFormatPlan,
    caption,
    verbalTics: config.persona.voice.verbalTics
  });
```

- [ ] **Step 7: Run** `pnpm vitest run tests/story-format-plan.test.ts tests/generate-command.test.ts` → PASS, then `pnpm check` → all green.

- [ ] **Step 8: Commit**

```bash
git add src/story-format-plan.ts src/generate-command.ts tests/story-format-plan.test.ts tests/generate-command.test.ts
git commit -m "✨ feat(history): 캡션에서 실제 쓴 tic과 마무리 줄을 formats.json에 남긴다 (UNC-280)" -m "..."
```

---

### Task 2 (UNC-281): 최근 3일 사용된 verbalTic을 그날 캡션 signature phrases에서 제외

**Files:**
- Modify: `src/diary-generator.ts` (`GenerateCaptionOptions` ~92-100, `buildPersonaCaptionLines` 438-461, `buildCaptionInstructions` 463-546, `generateCaption` 691-711; type import from `./story-format-plan.js` ~28-32)
- Modify: `src/generate-command.ts:539-547`
- Test: `tests/diary-generator.test.ts`

**Interfaces:**
- Consumes (Task 1): `RecentStoryFormat` with `captionSurface?: { usedTics: string[]; landingLine?: string }` from `src/story-format-plan.ts`.
- Produces (Task 3 relies on these):
  ```ts
  export const CAPTION_REPETITION_WINDOW_DAYS = 3;
  export type CaptionHistoryContext = {
    targetDate: string;                          // YYYY-MM-DD, 오늘 캡션의 날짜
    recentFormats: readonly RecentStoryFormat[];
  };
  /** targetDate 이전 1..N일 안의 엔트리만, 날짜 내림차순(안정 정렬). 없으면 []. */
  export function selectCaptionHistoryWindow(captionHistory?: CaptionHistoryContext): RecentStoryFormat[];
  export function selectRotatedVerbalTics(verbalTics: readonly string[], windowEntries: readonly RecentStoryFormat[]): string[];
  // buildCaptionInstructions options gain: captionHistory?: CaptionHistoryContext
  // GenerateCaptionOptions gains: recentFormats?: RecentStoryFormat[]
  ```

**윈도 정의:** 엔트리 날짜가 `targetDate - 1일` ~ `targetDate - 3일`(달력 기준, UTC 날짜 차)인 것만. 같은 날짜(재생성으로 생긴 오늘 엔트리)와 미래 날짜는 제외. 같은 날짜 엔트리가 여러 개면 전부 합산.

**부활 규칙 (AC3):** 윈도 안에서 persona의 모든 tic이 쓰였으면, 각 tic의 "가장 최근 사용 위치"(날짜 내림차순 윈도에서 처음 등장한 index)가 가장 큰 tic 1개만 남긴다. 동률이면 persona `verbalTics` 순서상 앞의 것.

**⚠️ 테스트 persona:** Task 4가 프리셋 tic을 늘리므로, 이 Task의 테스트는 프리셋 tic 개수에 의존하면 안 된다. 반드시 명시적 tic을 가진 persona를 만든다:
```ts
const twoTicPersona: Persona = {
  ...captionTestPersona,
  voice: { ...captionTestPersona.voice, verbalTics: ["...음.", "그렇군."] }
};
```

- [ ] **Step 1: Write failing tests** — add a `describe("caption verbalTic rotation (UNC-281)", ...)` block to `tests/diary-generator.test.ts`; import `CAPTION_REPETITION_WINDOW_DAYS`, `selectRotatedVerbalTics`, `selectCaptionHistoryWindow` from `../src/diary-generator.js` and type `RecentStoryFormat` from `../src/story-format-plan.js`.

```ts
describe("caption verbalTic rotation (UNC-281)", () => {
  const twoTicPersona: Persona = {
    ...captionTestPersona,
    voice: { ...captionTestPersona.voice, verbalTics: ["...음.", "그렇군."] }
  };
  const threeTicPersona: Persona = {
    ...captionTestPersona,
    voice: { ...captionTestPersona.voice, verbalTics: ["...음.", "그렇군.", "역시나."] }
  };
  const entry = (date: string, usedTics: string[], landingLine?: string): RecentStoryFormat => ({
    date,
    mood: "grind",
    captionSurface: landingLine === undefined ? { usedTics } : { usedTics, landingLine }
  });
  const signatureLine = (instructions: string): string | undefined =>
    instructions.split("\n").find((line) => line.startsWith("Signature phrases"));

  it("uses a 3-day window", () => {
    expect(CAPTION_REPETITION_WINDOW_DAYS).toBe(3);
  });

  it("excludes tics used in the last 3 days from the signature phrases line", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: threeTicPersona,
      moodPlan: captionTestMoodPlan,
      captionHistory: {
        targetDate: "2026-05-12",
        recentFormats: [entry("2026-05-11", ["그렇군."]), entry("2026-05-09", ["...음."])]
      }
    });

    expect(signatureLine(instructions)).toBe(
      "Signature phrases you may use naturally (do not force every line): 역시나.."
    );
  });

  it("ignores tics used outside the window (4+ days ago) and on the target date itself", () => {
    const window = selectCaptionHistoryWindow({
      targetDate: "2026-05-12",
      recentFormats: [
        entry("2026-05-12", ["그렇군."]),
        entry("2026-05-11", []),
        entry("2026-05-08", ["...음."])
      ]
    });

    expect(window.map((format) => format.date)).toEqual(["2026-05-11"]);
    expect(selectRotatedVerbalTics(["...음.", "그렇군."], window)).toEqual(["...음.", "그렇군."]);
  });

  it("merges every record in the window, including two records on the same date", () => {
    const window = selectCaptionHistoryWindow({
      targetDate: "2026-05-12",
      recentFormats: [entry("2026-05-11", ["그렇군."]), entry("2026-05-11", ["역시나."])]
    });

    expect(selectRotatedVerbalTics(["...음.", "그렇군.", "역시나."], window)).toEqual(["...음."]);
  });

  it("revives exactly the least-recently used tic when every tic was used recently (boundary)", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: twoTicPersona,
      moodPlan: captionTestMoodPlan,
      captionHistory: {
        targetDate: "2026-05-12",
        recentFormats: [entry("2026-05-11", ["그렇군."]), entry("2026-05-10", ["...음."])]
      }
    });

    expect(signatureLine(instructions)).toBe(
      "Signature phrases you may use naturally (do not force every line): ...음.."
    );
  });

  it("breaks a least-recently-used tie by persona order", () => {
    expect(
      selectRotatedVerbalTics(["...음.", "그렇군."], [entry("2026-05-11", ["그렇군.", "...음."])])
    ).toEqual(["...음."]);
  });

  it("produces byte-identical instructions when history is empty or carries no captionSurface (AC5)", () => {
    const baseline = buildCaptionInstructions({
      quiet: false,
      persona: twoTicPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(
      buildCaptionInstructions({
        quiet: false,
        persona: twoTicPersona,
        moodPlan: captionTestMoodPlan,
        captionHistory: { targetDate: "2026-05-12", recentFormats: [] }
      })
    ).toBe(baseline);
    expect(
      buildCaptionInstructions({
        quiet: false,
        persona: twoTicPersona,
        moodPlan: captionTestMoodPlan,
        captionHistory: {
          targetDate: "2026-05-12",
          recentFormats: [{ date: "2026-05-11", mood: "grind", angle: "legacy" }]
        }
      })
    ).toBe(baseline);
  });

  it("generateCaption relays recentFormats with the activity summary's targetDate", async () => {
    // Use the existing caption-generator MockAiProvider pattern in this file
    // (see other generateCaption tests) with a valid caption response.
    // Pass persona: twoTicPersona and
    // recentFormats: [entry("<targetDate - 1 day>", ["그렇군."])]
    // where targetDate is the activity summary's targetDate from the existing helper.
    // Expect provider.requests[0].instructions to contain
    // "Signature phrases you may use naturally (do not force every line): ...음.."
    // and not the "그렇군." variant of that line.
  });
});
```
For the last test, write it concretely by copying an existing `generateCaption` test's provider/summary setup in this file (search `await generateCaption(`); compute the previous date from the summary helper's `targetDate` literal (read it — the file uses a fixed date).

- [ ] **Step 2: Run** `pnpm vitest run tests/diary-generator.test.ts -t "UNC-281"` → FAIL.

- [ ] **Step 3: Implement in `src/diary-generator.ts`**

Add `RecentStoryFormat` to the existing `import type { ... } from "./story-format-plan.js";`.

```ts
/**
 * UNC-281: 표층 문구 반복 회피 윈도 (일).
 * 실측(2026-07-22~24)에서 같은 추임새가 3일 연속 반복된 것이 가장 눈에
 * 띄었으므로, 최소 3일은 같은 tic·마무리 줄을 피한다.
 */
export const CAPTION_REPETITION_WINDOW_DAYS = 3;

const MS_PER_DAY = 86_400_000;

export type CaptionHistoryContext = {
  targetDate: string;
  recentFormats: readonly RecentStoryFormat[];
};

/**
 * targetDate 이전 1..N일(달력 기준)의 엔트리만 날짜 내림차순으로 돌려준다.
 * 같은 날짜의 여러 레코드(다른 mood로 재생성)는 전부 포함한다. 오늘 날짜
 * 엔트리(같은 날 재생성)는 "지난 며칠"이 아니므로 제외한다.
 */
export function selectCaptionHistoryWindow(
  captionHistory?: CaptionHistoryContext
): RecentStoryFormat[] {
  if (captionHistory === undefined) {
    return [];
  }

  const target = Date.parse(`${captionHistory.targetDate}T00:00:00Z`);

  if (Number.isNaN(target)) {
    return [];
  }

  return captionHistory.recentFormats
    .filter((format) => {
      const entry = Date.parse(`${format.date}T00:00:00Z`);

      if (Number.isNaN(entry)) {
        return false;
      }

      const daysAgo = Math.round((target - entry) / MS_PER_DAY);

      return daysAgo >= 1 && daysAgo <= CAPTION_REPETITION_WINDOW_DAYS;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * UNC-281: 윈도 안에서 쓰인 tic을 뺀 나머지를 돌려준다. 전부 쓰였으면
 * signature phrases 줄이 사라지지 않도록 가장 오래 전에 쓴 tic 1개만
 * 되살린다 (동률은 persona 순서상 앞의 것).
 */
export function selectRotatedVerbalTics(
  verbalTics: readonly string[],
  windowEntries: readonly RecentStoryFormat[]
): string[] {
  const lastUseIndex = new Map<string, number>();

  windowEntries.forEach((format, index) => {
    for (const tic of format.captionSurface?.usedTics ?? []) {
      if (!lastUseIndex.has(tic)) {
        lastUseIndex.set(tic, index);
      }
    }
  });

  const unused = verbalTics.filter((tic) => !lastUseIndex.has(tic));

  if (unused.length > 0 || verbalTics.length === 0) {
    return unused;
  }

  let revived = verbalTics[0];

  for (const tic of verbalTics) {
    if ((lastUseIndex.get(tic) ?? 0) > (lastUseIndex.get(revived) ?? 0)) {
      revived = tic;
    }
  }

  return [revived];
}
```
(Adjust for `noUncheckedIndexedAccess` if enabled — `verbalTics[0]` is safe here because length > 0 is established; use a non-null fallback if the compiler requires it.)

`buildPersonaCaptionLines(persona: Persona, captionHistory?: CaptionHistoryContext)`: replace the tic block with

```ts
  const verbalTics = selectRotatedVerbalTics(
    voice.verbalTics,
    selectCaptionHistoryWindow(captionHistory)
  );

  if (verbalTics.length > 0) {
    lines.push(
      `Signature phrases you may use naturally (do not force every line): ${verbalTics.join(", ")}.`
    );
  }
```

`buildCaptionInstructions` options: add `captionHistory?: CaptionHistoryContext;` and call `...buildPersonaCaptionLines(options.persona, options.captionHistory),`.

`GenerateCaptionOptions`: add `recentFormats?: RecentStoryFormat[];`. In `generateCaption`'s `buildCaptionInstructions({...})` call add:

```ts
      captionHistory:
        options.recentFormats === undefined
          ? undefined
          : {
              targetDate: options.activitySummary.targetDate,
              recentFormats: options.recentFormats
            }
```
(If `exactOptionalPropertyTypes` rejects `undefined`, use a conditional spread instead.)

- [ ] **Step 4: Wire `src/generate-command.ts:539`** — add `recentFormats` (already in scope from line 389) to the `generateCaption({...})` argument object.

- [ ] **Step 5: Run** `pnpm vitest run tests/diary-generator.test.ts` → PASS, then `pnpm check` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/diary-generator.ts src/generate-command.ts tests/diary-generator.test.ts
git commit -m "✨ feat(caption): 최근 3일 쓴 말버릇을 그날 signature phrases에서 뺀다 (UNC-281)" -m "..."
```

---

### Task 3 (UNC-282): 캡션 프롬프트에 최근 마무리 문구 회피 블록 추가

**Files:**
- Modify: `src/diary-generator.ts` (`buildCaptionInstructions` return array, end of `=== RULES ===` section)
- Test: `tests/diary-generator.test.ts`

**Interfaces:**
- Consumes (Task 2): `CaptionHistoryContext`, `selectCaptionHistoryWindow`, `buildCaptionInstructions({ captionHistory })`.
- Produces: `buildRecentLandingLineAvoidanceLines(captionHistory?: CaptionHistoryContext): string[]` (module-private is fine).

**범위 가드:** `src/story-format-plan.ts`의 `buildRecentFormatsDiversityInstructions`(mood/angle plan 프롬프트)는 수정하지 않는다. 착지 형태 분류 체계는 만들지 않는다.

- [ ] **Step 1: Write failing tests** — add `describe("caption landing-line avoidance (UNC-282)", ...)` to `tests/diary-generator.test.ts`:

```ts
describe("caption landing-line avoidance (UNC-282)", () => {
  const entry = (date: string, landingLine?: string): RecentStoryFormat => ({
    date,
    mood: "grind",
    captionSurface: landingLine === undefined ? { usedTics: [] } : { usedTics: [], landingLine }
  });
  const avoidanceLine = (instructions: string): string | undefined =>
    instructions.split("\n").find((line) => line.startsWith("Recently used closing lines"));

  it("lists recent landing lines from the 3-day window as avoidance targets", () => {
    const instructions = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan,
      captionHistory: {
        targetDate: "2026-05-12",
        recentFormats: [
          entry("2026-05-11", "그렇군. 오늘도 테스트가 이겼다."),
          entry("2026-05-10", "내일은 조금 빠르길."),
          entry("2026-05-10", "내일은 조금 빠르길."),
          entry("2026-05-07", "창밖만 봤음.")
        ]
      }
    });
    const line = avoidanceLine(instructions);

    expect(line).toBeDefined();
    expect(line).toContain("\"그렇군. 오늘도 테스트가 이겼다.\"");
    expect(line).toContain("\"내일은 조금 빠르길.\"");
    expect(line?.match(/내일은 조금 빠르길/g)).toHaveLength(1);
    expect(line).not.toContain("창밖만 봤음.");
  });

  it("emits nothing and keeps the instructions byte-identical when no landing lines are in the window (AC5)", () => {
    const baseline = buildCaptionInstructions({
      quiet: false,
      persona: captionTestPersona,
      moodPlan: captionTestMoodPlan
    });

    expect(
      buildCaptionInstructions({
        quiet: false,
        persona: captionTestPersona,
        moodPlan: captionTestMoodPlan,
        captionHistory: { targetDate: "2026-05-12", recentFormats: [entry("2026-05-11")] }
      })
    ).toBe(baseline);
  });
});
```
(`entry("2026-05-11")` with `usedTics: []` must not change the signature phrases line either — confirms AC5 across T2+T3.)

- [ ] **Step 2: Run** `pnpm vitest run tests/diary-generator.test.ts -t "UNC-282"` → FAIL.

- [ ] **Step 3: Implement**

```ts
/**
 * UNC-282: 최근 윈도에서 쓴 마무리 줄을 캡션 지시문의 회피 목록으로 싣는다.
 * 착지 형태를 분류하지 않고, 실제 문장을 보여 주고 문장 모양까지 피하게 한다.
 * 기록이 없으면 아무것도 싣지 않는다 (히스토리가 빈 날 지시문은 이전과 동일).
 */
function buildRecentLandingLineAvoidanceLines(
  captionHistory?: CaptionHistoryContext
): string[] {
  const landingLines = [
    ...new Set(
      selectCaptionHistoryWindow(captionHistory)
        .map((format) => format.captionSurface?.landingLine?.trim() ?? "")
        .filter((line) => line.length > 0)
    )
  ];

  if (landingLines.length === 0) {
    return [];
  }

  return [
    `Recently used closing lines: ${landingLines.map((line) => `"${line}"`).join(" / ")}. Do not end today's caption with any of these lines or a near-copy of their sentence shape; land on a different kind of final line.`
  ];
}
```
Append `...buildRecentLandingLineAvoidanceLines(options.captionHistory)` as the **last** element of the array returned by `buildCaptionInstructions` (after `...buildRecurringThreadInstructionLines(options.recurringThreads)`).

- [ ] **Step 4: Run** `pnpm vitest run tests/diary-generator.test.ts` → PASS, then `pnpm check` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/diary-generator.ts tests/diary-generator.test.ts
git commit -m "✨ feat(caption): 최근 마무리 줄을 캡션 지시문의 회피 목록에 싣는다 (UNC-282)" -m "..."
```

---

### Task 4 (UNC-283): 3일 로테이션 윈도를 견디도록 persona 프리셋 verbalTics 풀 확장

**Files:**
- Modify: `src/persona.ts:91, 119, 147, 175`
- Test: `tests/persona.test.ts`

**Interfaces:**
- Consumes (Task 2): `CAPTION_REPETITION_WINDOW_DAYS` from `src/diary-generator.ts` (import it in the test only; do NOT import diary-generator from persona.ts).
- Produces: none.

**규칙:** 기존 두 tic은 **그대로 두고 순서도 유지**한 채 뒤에 3개를 추가한다(프리셋당 5개). 톤 유지, 어휘 재작성 금지. 기존 사용자 config 스냅샷 백필(마이그레이션)은 범위 밖. 추가 문구(아래 그대로 사용):

| 프리셋 | 기존 | 추가 |
|---|---|---|
| 까칠한 시니어 (formal, terse, dry) | "정확히 말하면", "그건 좀..." | "근거는요?", "일단 짚고 넘어가죠", "다시 봅시다" |
| 다정한 페어 (casual, warm) | "괜찮아요", "같이 해봐요" | "천천히 해요", "오 좋은데요?", "여기까지 온 게 어디예요" |
| 시니컬한 관찰자 (mixed, sarcastic) | "...음.", "그렇군." | "역시나.", "뭐, 그럴 수 있지.", "기록해 둡니다." |
| 텐션 높은 주니어 (casual, absurd) | "대박", "미쳤다" | "와 이게 되네", "레전드", "실화임?" |

- [ ] **Step 1: Write failing test** — in `tests/persona.test.ts` add `import { CAPTION_REPETITION_WINDOW_DAYS } from "../src/diary-generator.js";` and inside `describe("PERSONA_PRESETS", ...)`:

```ts
  it("ships enough distinct verbalTics per preset to outlast the caption rotation window (UNC-283)", () => {
    for (const name of PERSONA_PRESET_NAMES) {
      const tics = PERSONA_PRESETS[name].persona.voice.verbalTics;

      expect(new Set(tics).size).toBe(tics.length);
      expect(tics.length).toBeGreaterThan(CAPTION_REPETITION_WINDOW_DAYS);
    }
  });

  it("keeps each preset's original verbalTics first and unchanged (tone preserved, UNC-283)", () => {
    expect(PERSONA_PRESETS["까칠한 시니어"].persona.voice.verbalTics.slice(0, 2)).toEqual(["정확히 말하면", "그건 좀..."]);
    expect(PERSONA_PRESETS["다정한 페어"].persona.voice.verbalTics.slice(0, 2)).toEqual(["괜찮아요", "같이 해봐요"]);
    expect(PERSONA_PRESETS["시니컬한 관찰자"].persona.voice.verbalTics.slice(0, 2)).toEqual(["...음.", "그렇군."]);
    expect(PERSONA_PRESETS["텐션 높은 주니어"].persona.voice.verbalTics.slice(0, 2)).toEqual(["대박", "미쳤다"]);
  });
```

- [ ] **Step 2: Run** `pnpm vitest run tests/persona.test.ts` → first test FAILS (2 tics ≤ 3).

- [ ] **Step 3: Implement** — edit the four `verbalTics` arrays in `src/persona.ts` per the table (e.g. line 147 → `verbalTics: ["...음.", "그렇군.", "역시나.", "뭐, 그럴 수 있지.", "기록해 둡니다."],`). Add one comment above the `PERSONA_PRESETS` constant or on the first array: `// UNC-283: 3일 로테이션 윈도(CAPTION_REPETITION_WINDOW_DAYS)보다 많은 tic을 둬야 소진 fallback이 일상이 되지 않는다. 기존 두 tic은 톤 기준점이라 앞에 그대로 둔다.`

- [ ] **Step 4: Run** `pnpm vitest run tests/persona.test.ts` → PASS. Then run the full suite `pnpm check` — some existing tests may assert exact preset tic content (e.g. `toEqual(PERSONA_PRESETS[...].persona)` is fine since it reads the constant; a hardcoded literal list would need updating). Update only such expectation literals, nothing else.

- [ ] **Step 5: Commit**

```bash
git add src/persona.ts tests/persona.test.ts
git commit -m "✨ feat(persona): 로테이션 윈도를 견디도록 프리셋 말버릇 후보를 늘린다 (UNC-283)" -m "..."
```

---

## Self-Review

- Spec coverage: AC1 → Task 1 (round-trip, backward compat, malformed field tolerance, projection). AC2 → Task 2 exclusion tests. AC3 → Task 2 revive/boundary tests. AC4 → Task 3. AC5 → Task 1 (record shape unchanged without caption), Task 2 + Task 3 byte-identical tests. Q2 → Task 4. Redaction before storage → Task 1 sanitize test. Story-plan provider input unchanged → Task 1 test.
- Type consistency: `CaptionSurface{usedTics,landingLine?}`, `RecentStoryFormat.captionSurface`, `CaptionHistoryContext{targetDate,recentFormats}`, `selectCaptionHistoryWindow`, `selectRotatedVerbalTics`, `CAPTION_REPETITION_WINDOW_DAYS` used identically across tasks.
