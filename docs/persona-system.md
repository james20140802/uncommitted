# Persona System — Design Notes

Status: **post-MVP design exploration.** Not yet scoped into issues. Depends on
source expansion (Linear `UNC-115`). Product strategy stays in Notion; this
document captures the agreed design direction so it survives between sessions.

## Why

The MVP already has an "AI coworker" voice, but as a *system* the persona is
thin and weakly wired:

- It is a single free-text string (`persona: string`) plus a numeric
  `roastLevel` (see `src/diary-generator.ts`).
- That string is barely injected — for captions it only appears inside an
  overview line (`Persona: ... Roast level: ...`). The actual voice is carried
  by **hardcoded few-shot examples** in `buildCaptionInstructions()`, so today
  the coworker's voice is effectively a constant, not a configurable persona.
- Day-to-day variety is instead produced by a **rotating story genre**
  (`StoryFormatPlan`: case file, trial, broadcast, field note, …). In practice
  this overshoots into try-hard, costume-y writing ("today's verdict",
  "evidence A"). `UNC-62` already removed genre performance from *captions*;
  *story slides* still perform it.
- There is **no continuity**. The coworker is reborn every day. It cannot say
  "또 그 race condition이야?" because it does not remember yesterday.

## Guiding thesis

Move the engine of day-to-day freshness **off genre costume and onto persona
voice + short-term memory**, fed by richer source material.

```
source expansion (UNC-115)
        │  richer daily material + open threads
        ▼
persona voice + short-term memory
        │  consistent identity reacting to genuinely new material
        ▼
story format genre dependency shrinks / is removed
```

A consistent coworker reacting to genuinely different material *with continuity*
reads as natural variety. Putting on a different hat each day does not.

## Design

### 1. Persona as structured config (presets + knobs)

Promote `persona: string` to a structured persona object. A **preset is just a
named bundle of knob values**, so presets and fine-grained knobs are the same
mechanism at two altitudes.

Knobs (illustrative):

- **identity**: name, relationship to the developer (senior / peer / junior /
  observer), one-line backstory
- **voice**: register (formal↔casual), sentence length, verbal tics /
  catchphrases, emoji usage, Korean/English mix
- **humor**: roast intensity (reuses existing `roastLevel`), roast targets,
  humor style (dry / warm / sarcastic / absurd)
- **reaction tendencies**: what it notices, what annoys it, what delights it

Global safety boundaries are inherited and non-negotiable (never attack
identity, ability, appearance, mental health, personal value, or real life).

### 2. Presets + user selection

Ship a few archetypes so users do not author from scratch; let them select one,
and let advanced users override individual knobs.

Candidate presets:

- `까칠한 시니어` — roast↑, dry, terse
- `다정한 페어` — roast↓, warm, encouraging
- `시니컬한 관찰자` — medium roast, deadpan, detached
- `텐션 높은 주니어` — roast↓, enthusiastic, emoji-heavy

Selection UX: choose during `init`; change via `uncommitted persona set
<preset>`; optional per-knob overrides in config. The hardcoded caption identity
and few-shot examples should be **parameterized by the selected persona** rather
than baked in.

### 3. Short-term memory (file-based)

The agreed scope is **short-term memory** (session-consistent tone + recent
recurring threads), not long-term life-story memory.

Key observation: `activity-summary` already computes `unfinishedThreads`,
`possibleJokes`, `smallWins`, and `blockersOrConfusion` — but only for a single
day. **Short-term memory = giving these a lifespan across days**, not a new
concept.

Reference patterns we are borrowing from (all file-based / local-friendly):

- **Claude Code `CLAUDE.md` / memory files** — human-readable, editable
  markdown injected into context each run. Closest analog to our local-first
  ethos.
- **MemGPT / Letta** — tiered memory: a small always-present *core memory*
  (persona + key facts) plus a larger *recall/archival* store paged in on
  demand; the agent edits its own memory.
- **Generative Agents (Stanford "Smallville")** — a memory stream of timestamped
  observations, retrieval scored by *recency × importance × relevance*, and a
  periodic *reflection* step that synthesizes raw observations into higher-level
  insights. Reflection is what produces "this dev keeps fighting the same bug".
- **ChatGPT saved memories** — a bounded list of short, auto-extracted,
  user-editable facts.

Proposed layout (no vector DB needed at this stage):

- `~/.uncommitted/memory/persona.json` — selected preset + knob overrides +
  a small bounded set of durable *core facts* (always injected). Mirrors
  MemGPT core memory + ChatGPT saved memories.
- `.uncommitted/memory/threads.jsonl` — short-term *active threads*:
  `{ id, firstSeen, lastSeen, kind (bug | refactor | running-joke | …), note,
  status, decay }`. Bounded by last-N-days / max entries, with recency decay.
- **Reflection step** in `generate`: read recent normalized event signals (from
  `UNC-115`), update/create/expire threads. Store only distilled, redacted
  notes — never raw transcripts or diffs, so memory inherits the existing
  privacy guarantees.
- **Injection**: at generate time, pull the top-K active threads into the
  existing `unfinishedThreads` / `possibleJokes` slots.
- `uncommitted memory` command (later) to inspect and edit, keeping the user in
  control — consistent with local-first.

Memory is only as rich as its inputs, which is **why this depends on `UNC-115`**.

### 4. Story format rework — remove genre, vary by angle + pacing

Decision: **remove the rotating genre costume.** Replace the variety axis with:

- **Natural angle / lens** — what the coworker fixates on that day: the one
  annoying bug, the thing we kept avoiding, a small win nobody noticed, the tool
  that betrayed us, the quiet observation. These are honest framings, not
  costumes.
- **Pacing / structure** — mechanical variety (slide count, whether it opens on
  a scene vs a thought, hook→turn→landing rhythm) that does not announce a
  genre.

Freshness load shifts to persona voice (section 1–2) + short-term memory
(section 3). `StoryFormatPlan` is reduced to voice-neutral structure, or removed
in favor of angle + pacing selection.

### 5. Calibration via feedback

The feedback loop is already partly wired for this. `REASON_PROMPT_AREA_MAP`
(see `src/feedback-types.ts`) maps:

- `awkward-roast` → "Persona / roast level prompt"
- `too-harsh` → "Roast policy + Safety Reviewer"
- `repetitive-format` → "Story Inventor prompt + format history"
- `too-generic` → "Story Inventor + Writer prompt"

After ~7 days of dogfooding, aggregated feedback can suggest persona knob
adjustments (e.g. lower roast intensity, widen angle variety) instead of manual
prompt editing.

## Connections to current code

- `src/diary-generator.ts` — `persona: string`, `roastLevel`, hardcoded caption
  identity + few-shot examples; the main integration surface.
- `src/story-format-plan.ts` — current genre rotation; the rework target.
- `src/activity-summary.ts` — already emits `unfinishedThreads` / `possibleJokes`
  / `smallWins`; the seed of short-term memory.
- `src/feedback-types.ts` — `REASON_PROMPT_AREA_MAP` for the calibration loop.

## Out of scope (for this milestone)

- Long-term / life-story memory and running-joke synthesis (a later phase, once
  source expansion is mature).
- Visual / character work (separate track; currently deferred pending feedback
  data).
- Multiple simultaneous personas per project.
- Vector / embedding retrieval (only if recency + keyword matching proves
  insufficient).
- Instagram auto-publishing.

## Risks / open questions

- **Voice repetition.** A fixed persona run daily can still feel samey even with
  new material. Anti-repetition must be designed into voice + angle variety, not
  only memory.
- **Memory drift / staleness.** Threads must decay and expire, or stale "open
  loops" will mislead the writer.
- **Privacy.** Memory derives from source signals that must already be redacted
  upstream (`UNC-115`); memory entries also pass safety before injection.
- **Removing genre vs. losing structure.** Need to confirm angle + pacing alone
  give enough variety once genre is gone; keep a feedback checkpoint.

## Rough sequencing

1. `UNC-115` source expansion (prerequisite — richer material + threads).
2. Structured persona config + presets + selection (section 1–2).
3. Story format rework to angle + pacing (section 4).
4. Short-term memory: thread persistence + reflection + decay (section 3).
5. Feedback-driven persona calibration (section 5).
