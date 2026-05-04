# Changelog

## Unreleased

### Fixed: long-horizon turns silently disappearing mid-stream

Long-running models — especially Deepseek V4 Pro and Qwen 3.6 Plus on Venice —
would think for a long time and then vanish. The response would just stop, no
error, no recovery. "Finish what you started" sometimes worked but increasingly
didn't.

**Root cause.** The webui spawns `openclaude` fresh per turn (no `--resume`)
and packs the entire conversation into a single prompt sized at
`0.6 × model.context_window`. For Deepseek/Qwen at 1M-token windows, that's a
~600k-token packed prompt. But the openclaude CLI doesn't have those models in
its integration metadata — so it falls back to a conservative **128k** context
window and triggers internal auto-compact at ~95k tokens. Auto-compact fires a
same-model summarization API call (slow, often hangs or times out), and when
it finally fails, the CLI exits without a `result` event. The runner logged the
exit server-side but emitted no error to the user.

**Fixes** (`src/server/services/runner.ts`, `src/server/routes/messages.ts`):

1. **Disable openclaude's internal auto-compact** (`DISABLE_AUTO_COMPACT=1`,
   `DISABLE_COMPACT=1`). The webui already manages history via
   `buildConversationPrompt`; the CLI's compaction layer was redundant and
   actively harmful.
2. **Pass the model's real context window** to openclaude via
   `CLAUDE_CODE_OPENAI_FALLBACK_CONTEXT_WINDOW`, sourced from
   `models.json`. Stops the silent 128k clamp and the `[context] Warning: model
   not in integration model metadata` stderr spam (was logging thousands of
   times per request).
3. **Cap webui input budget at 200k tokens.** 600k-token prompts on 1M-window
   providers degrade quality and stall upstream — most providers fall apart
   well before their advertised ceiling. New ceiling:
   `Math.min(contextWindow * 0.6, 200_000)`.
4. **Surface mid-stream openclaude exits to the user.** Previously, when the
   CLI streamed partial text and then died, the runner only logged the exit
   server-side. The user saw the response stop and assumed completion. Now
   emits `[response cut off mid-stream — <reason>]` so the silent disconnect is
   visible.

### Added: type-checking now passes (`tsc --noEmit`)

Installed `@types/node` and triaged the errors that surfaced. Project still
runs via `tsx` at runtime, but `npx tsc --noEmit` now exits clean and will
catch regressions.

- `runner.ts` — Removed bogus `encoding: 'utf8'` from `spawn()` options. It
  isn't a valid `SpawnOptions` field and was causing TypeScript to type
  `proc.stdin` / `proc.stderr` as `never`. Stream encoding is correctly
  applied via `proc.stderr.setEncoding()` after spawn.
- `messages.ts` — Widened `turnMedia` type to include `'audio'` to match the
  runner's `RunnerEvent.media` type union.
- `messages.ts`, `models.ts`, `sessions.ts`, `status.ts` (8 callsites) — The
  `c.req.json<T>().catch(() => ({}))` pattern widened the result to `T | {}`,
  causing `Property does not exist on '{}'` errors. Typed the catch handler:
  `.catch((): T => ({}))`.
- `model.ts` — `discoverAndSaveModels` declared `Promise<Model[]>` but
  `ModelWithContext` had `type` optional during discovery. Default missing
  types to `'text'` before returning, matching what `getConfiguredModels` does
  via regex inference at read time.
