# Changelog

## Unreleased

### Adversarial sweep follow-through

Worked through the findings catalogued in `final-sweep.md`. Net change:
+722 / -4,659 across 47 files; type-check now passes with `strict: true` and
`noUncheckedIndexedAccess`. Eight phases:

1. **Cleanup** — deleted the dead Python backend (`api/`, `server.py`,
   `run.sh`, `e2e_test.py`, `static/`); re-registered `anthropicProxy` in
   `index.ts`; built `PROXY_MAP` URLs from `PORT` instead of the hardcoded
   `8789`; dropped the unused `restartServer` export.
2. **Strict TypeScript** — turned on `strict: true` +
   `noUncheckedIndexedAccess`, fixed all 39 surfaced errors (mostly array
   access without undefined checks and `cmd[0]`-into-`spawn` propagating to
   `proc.stdin/stderr` typed as `never`).
3. **Auth + path safety** — bound the listener to `127.0.0.1` only;
   removed the loopback auth bypass (anonymous mode now requires the auth
   file to be absent, not just that the request came from localhost);
   moved `/api/upload`, `/api/attachments`, `/api/media` behind the auth
   middleware; switched token comparison to `timingSafeEqual` with
   length-padded inputs; made IP detection fail closed; added UUID
   validation to `sessionPath` to block path-traversal via session ids;
   narrowed `media.ts` `ALLOWED_ROOTS` to webui dirs only (no more
   `~/Pictures`, `~/Downloads`, `/tmp`); fixed `writeEnvFile` to
   single-quote-escape values.
4. **Data integrity** — atomic session writes (tmp + rename); per-session
   async mutex around all mutating session ops to kill the
   read-modify-write race between fire-and-forget user-message saves and
   assistant saves; awaited `createSession` so the session is on disk
   before the response returns; same atomic write pattern for `writeJson`
   in config.
5. **Resource management** — runner cleanup on natural exit (was leaking
   into `activeRunners` Map indefinitely); 8-concurrent-runner cap with a
   synthetic error-event runner returned at the limit; process-group kill
   on cancel (kills openclaude grandchildren too); `setInterval`-based
   prune for the proxy stream caches; sync→async I/O in upload + media;
   `createReadStream({ start, end })` for range requests instead of
   loading the whole file; 25 MB body cap on every proxy.
6. **Error handling** — every silent `try/catch { /* ignore */ }` now
   logs to stderr with context; upstream `fetch` failures in proxies
   become `502` with reason instead of generic 500; venice SSE rewrite
   now buffers partial lines (the previous version split chunks on `\n`
   without holding a trailing partial, mangling JSON events that
   straddled TCP packets); SIGTERM/SIGINT now drain in-flight requests
   for up to 5s before exiting.
7. **API correctness** — single shared `stripInjectedIdentity` (was
   duplicated 4x with subtly different output); narrowed the regex to
   *only* match openclaude's actual injection patterns instead of the
   over-broad `\bOpenClaude\b` substitution that mangled user content
   referencing OpenClaude or Claude in chat; `COST_MAP` expanded with
   ~25 model patterns and now returns `null` for unknown instead of a
   misleading 1.0/4.0 guess; `parseJson` helper in `services/http.ts`;
   `claude-mem` URL/projects env-configurable; keepalive interval now
   bails on abort instead of writing forever.
8. **Ops + frontend** — CSP headers via Hono middleware *and* a `<meta>`
   tag in `dist/ui/index.html` (so the bundle gets browser-side defense
   too); `start.sh` and `stop.sh` are PID-safe (no more indiscriminate
   `fuser -k` that would kill any process binding the port); on-start
   log roll at 10 MB; `/api/healthz` lightweight liveness probe.

Skipped intentionally:
- Frontend source: not present in this repo, kept the runtime DOM-patch
  shims (`audio-shim.js`, `type-filter.js`).
- `MEDIA:` content prefix → structured event field: would require
  modifying the bundle; left alone.
- `searchSessions` indexing: needs a separate persistence layer change.
- `anthropicProxy` tool-use translation: text completions only; tool
  calls would need broader Anthropic API translation work.

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
