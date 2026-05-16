# UNC-62 Caption Voice Design

## Context

Issue #62 improves `caption.txt` quality for Uncommitted's AI coworker diary drafts. The current prompt contract can make captions feel too conceptual, too poetic, too report-like, or too visibly driven by the selected story genre.

The implementation should stay prompt-contract only. It should not add a caption scoring system, rule-based Korean style validator, new provider task, new data model, or runtime rejection for captions that merely sound awkward.

## Goal

Generated captions should read like the configured AI coworker persona posting a natural Korean Instagram caption after work.

The caption should mention one or two concrete work moments from the activity summary, then add the narrator's emotionally specific reaction. It should feel like something a person might actually post, not a polished writing exercise.

## Scope

- Strengthen `src/diary-generator.ts` instructions so the configured `persona` is explicitly the narrator.
- Keep `StoryFormatPlan` useful for story and carousel slide structure.
- Stop requiring the selected story genre to be visible in the caption.
- Prefer concrete work moments plus narrator reaction over abstract poetic phrasing.
- Explicitly reject status-report, changelog, task-summary, literary, inspirational, slogan-like, and abstract metaphor-heavy caption shapes.
- Add or update focused prompt-contract tests in `tests/diary-generator.test.ts`.
- Preserve existing safety, privacy, quiet-day honesty, and malformed provider output behavior.

## Out Of Scope

- Changing image prompts, visual asset generation, or carousel rendering.
- Changing the `StoryFormatPlan` schema.
- Adding Instagram auto-posting.
- Sending raw diffs, raw code, private paths, secrets, emails, or private URLs to AI providers.
- Adding a full caption ranking, scoring, or evaluation system.
- Rejecting provider output solely because the caption is stylistically weak.

## Design

### Genre Boundary

`StoryFormatPlan` remains the story and carousel planning layer. Its `formatName`, `voice`, `tone`, and `structure` can still shape slide titles, slide bodies, and the overall carousel flow.

The caption should not be required to perform the selected genre. A case file, trial, broadcast, or field note format may influence the surrounding story, but the caption should not be forced into phrases like "today's verdict," "evidence A," or "field report" just to make the genre visible.

The prompt should make this boundary explicit:

- Use the Story Format Plan for slide structure and story flow.
- Do not force the selected genre to be visible in the caption.
- It is fine if the genre lightly colors the caption, but the caption must remain natural Instagram copy.

### Persona As Narrator

The configured AI coworker persona is the writer, not a topic, tag, or style hint. The instructions should say that the persona is the narrator of the caption and should not be explained to the reader.

The caption should use the narrator's own reaction to the day. It may describe what the AI coworker noticed, waited for, got confused by, felt relieved about, or found mildly annoying. It must not claim to know the user's private emotions.

### Caption Style

The caption should prefer plain, casual, emotionally specific Korean.

It should sound like a real Instagram caption someone might post after work. A slightly imperfect casual caption is better than a polished metaphor. The prompt should discourage trying to sound literary, profound, inspirational, or clever.

Desired shape:

- Start from one or two real work moments.
- Add the narrator's reaction to those moments.
- Use everyday emotions such as frustration, relief, awkwardness, tiredness, doubt, stubbornness, small satisfaction, or mild embarrassment.
- Keep it copyable as an Instagram caption.

Rejected shapes:

- Status report, changelog, standup update, task summary, executive summary, or task handoff.
- Metric-led phrasing such as total commits, files changed, insertions, deletions, owner, next steps, or action items.
- Abstract literary lines, polished metaphors, inspirational phrasing, slogan-like sentences, or overly conceptual endings.

## Code Boundary

The main change belongs in `buildDiaryInstructions()` in `src/diary-generator.ts`.

The current instruction that makes the selected genre visible in the title, caption, slide titles, and slide bodies should be split. The revised contract should keep genre visibility for story and slides while carving caption out as persona-led Instagram copy.

`src/story-format-plan.ts` should remain mostly unchanged. It still owns format variety for the carousel. If implementation needs a small support line there, it should only clarify that `captionStyle` must not force genre performance in the caption.

No new public types, config fields, files, or storage artifacts are required.

## Data Flow

The existing generation flow stays unchanged:

1. `runGenerateCommand()` builds the daily activity summary.
2. `generateStoryFormatPlan()` creates the story format plan.
3. `generateDiaryDraft()` builds the draft request using the activity summary, persona, roast level, and story format plan.
4. `deriveCaptionText()` writes the generated caption and hashtags to `caption.txt`.

The issue is solved by changing the draft request instructions, not by changing provider orchestration.

## Error Handling

No new error code or exception type is needed.

Existing behavior remains:

- malformed provider JSON fails as an AI generation error;
- unsafe provider output fails as an unsafe diary draft;
- fabricated quiet-day activity fails existing quiet-day honesty checks;
- stylistically weak but structurally valid captions are not rejected.

## Testing

Focused tests should assert the prompt contract rather than generated caption quality.

`tests/diary-generator.test.ts` should cover:

- the instructions explicitly present the configured persona as the narrator;
- the instructions say the caption should not be forced to visibly perform the selected story genre;
- the instructions prefer concrete work moments plus narrator reaction;
- the instructions ask for real Instagram-caption-like, plain, casual Korean;
- the instructions reject report, changelog, task summary, and metric-led shapes;
- the instructions reject literary, polished, profound, inspirational, slogan-like, and abstract metaphor-heavy phrasing;
- existing privacy, safety, and quiet-day honesty instructions still appear.

The tests should not require a real provider or assert exact generated Korean output from an LLM.

## Acceptance Criteria Mapping

- Persona as narrator: covered by explicit diary instruction and prompt-contract test.
- Genre no longer required in caption: covered by split genre boundary and prompt-contract test.
- Concrete moments plus emotional reaction: covered by caption style instructions and prompt-contract test.
- Reject status-report shapes: covered by negative caption instruction and prompt-contract test.
- Reject literary or abstract phrasing: covered by negative caption instruction and prompt-contract test.
- Safety/privacy tests continue to pass: covered by unchanged validation behavior and full relevant test run.

## Remaining Risk

Prompt-contract changes can improve provider behavior, but they cannot guarantee every generated caption will feel natural. Real output examples should be reviewed after implementation. If captions remain inconsistent, a later issue can design a separate caption revision or evaluation layer with examples and acceptance thresholds.
