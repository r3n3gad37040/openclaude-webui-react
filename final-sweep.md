# Final Sweep — Adversarial Review of openclaude-webui

Date: 2026-05-04
Scope: full repo, with focus on the **live** code path (Hono/TypeScript backend + pre-built React bundle). Read-only audit. No code was changed.

This document catalogs presumed failure points, robustness gaps, and design weaknesses. Severities use a four-tier scale:

- **CRITICAL** — security boundary failure, data loss, or RCE-class issue
- **HIGH** — reliability/correctness bug a real user will hit
- **MEDIUM** — robustness gap, latent bug, or maintainability cost
- **LOW** — cosmetic, dead-code cleanup, or nice-to-have

Severities are calibrated for a **single-user local-only deployment** (the documented deployment model). Several findings would be CRITICAL in a multi-tenant context but downgrade to HIGH/MEDIUM here. That assumption is itself called out in finding §2.1.

---

## 0. Executive summary

Five themes emerge:

1. **Two parallel implementations live in this repo.** A dead Python backend (`api/`, `server.py`, `e2e_test.py`, `static/`) sits next to the live TypeScript backend (`src/server/`). Roughly 2,500 lines of dead code that doubles the attack surface during static review and confuses contributors.
2. **The frontend is a black box.** `src/ui/` contains only `assets/icon.png`. The actual React app lives only as a pre-built minified bundle in `dist/ui/`, plus two runtime DOM-patch shims (`audio-shim.js`, `type-filter.js`) that work around bugs the bundle can't be modified to fix. There is no buildable frontend in this repo.
3. **Authentication has a structural soft spot.** Loopback bypasses auth; provider proxies and uploads have no auth at all. For the documented single-user model this is "fine," but it means the threat model is "anyone with a foothold on this machine has full access to all keys, all sessions, and a relay-into-your-API-quota botnet."
4. **State is read/written without atomicity or locking.** Session JSON files, provider keys, preferences — every persistence path is a non-atomic read-modify-write. Two SSE streams writing to the same session race; a kill-during-write leaves a corrupt file.
5. **Resources leak slowly.** Completed runners stay in `activeRunners`, the proxy stream cache prunes only on cache miss, the SSE keepalive is paired with sync I/O, and there is no global limit on concurrent openclaude subprocesses. None of these will bite hard in normal use; all of them get worse over uptime.

---

## 1. Architecture & dead code

### 1.1 Dead Python backend duplicates the live TS backend  **HIGH**

Files: `api/__init__.py`, `api/auth.py`, `api/config.py`, `api/file_ingestion.py`, `api/model_switcher.py`, `api/pty_session.py`, `api/routes.py`, `api/sessions.py`, `server.py`, `run.sh`, `e2e_test.py`, `static/`

The TypeScript backend in `src/server/` (Hono on 8789) is what `start.sh` actually runs. The entire `api/` Python tree is from a prior implementation and is never imported, served, or executed in the current flow.

- `e2e_test.py` hits `http://localhost:8788` — that port has nothing on it.
- `server.py`'s `RequestHandler` wraps `api/routes.py` which contains its own auth, model switching, and SSE streaming.
- `static/index.html` + `static/app.js` is a vanilla-JS UI; the React bundle in `dist/ui/` superseded it.

Why it matters: confuses anyone reading the repo, doubles the surface area for the grep-for-secrets / grep-for-vulns sweep we just ran on `api/`, and rots over time. `pty_session.py:75` still hardcodes `/home/johnny/...` (PII leak) — and nobody noticed because the file isn't running.

Direction: delete `api/`, `server.py`, `run.sh`, `e2e_test.py`, `static/`. One commit, ~2,500 lines gone.

### 1.2 Frontend source is not in this repo  **HIGH**

Files: `src/ui/` (effectively empty), `dist/ui/assets/index-DMDECH7O.js` (296 KB minified)

The React/TanStack Query/zustand frontend that gets served is only present as a pre-built minified bundle. No `src/ui/components/`, no `App.tsx`, no `main.tsx`. The build pipeline (`tsc -b && vite build` in `package.json`) cannot regenerate it because the source it needs to compile doesn't exist.

Consequences:
- `npm run dev` is broken (`vite --port 5173` has no source to serve).
- `npm run build` is broken (would emit a fresh empty bundle that overwrites the working one).
- Any frontend bug requires editing the bundle by hand or shimming around it (which is exactly what `audio-shim.js` and `type-filter.js` do).
- A code review of the UI layer is impossible without unminifying.

Direction: this is the single biggest thing I'd want to fix on this project — either commit the frontend source, or document that the canonical source lives elsewhere and add a sync step.

### 1.3 Runtime shim band-aids hide bundle bugs  **MEDIUM**

Files: `dist/ui/assets/audio-shim.js`, `dist/ui/assets/type-filter.js`, referenced from `dist/ui/index.html:11-12`

`audio-shim.js` watches the DOM for `<img>` tags pointing at audio files (because the bundle's media renderer only branches `image | video`) and rewrites them into `<audio controls>` siblings. `type-filter.js` injects a `<style>` block to override the bundle's CSS at runtime.

Both work, but:
- They re-run on every React reconciliation, racing with React's own DOM ownership.
- Future bundle updates will silently break them (no tests).
- They mask bugs that ought to be fixed in source — except source is missing (§1.2).

Direction: when frontend source returns to the repo, fix the underlying bugs and delete the shims.

### 1.4 README and `install.sh` disagree  **LOW**

Files: `README.md:22-29`, `install.sh`

README says: `git clone … && npm install && bash start.sh`. `install.sh` does much more (copies files into `~/openclaude-webui/`, registers a `.desktop` launcher, generates an icon). Either path works in isolation, but a user following the README and then re-running `install.sh` ends up with a confusing mix.

Direction: either point README at `install.sh`, or strip `install.sh` to match README.

### 1.5 `restartServer()` exported but unused  **LOW**

File: `src/server/index.ts:86-103`

The function rebinds the same port. No internal caller. If exposed accidentally via a future route, it's a denial-of-service vector (caller can interrupt active streams).

Direction: delete or wire up to `/api/restart` instead of the current "cancel runners, leave server up" handler.

---

## 2. Security & authentication

### 2.1 Loopback auto-bypasses auth  **HIGH** (single-user) / **CRITICAL** (multi-user)

File: `src/server/middleware/auth.ts:37-40`

```ts
if (isLoopback(String(ip))) {
  await next()
  return
}
```

Any request from `127.0.0.1` skips auth entirely. The threat model is therefore "anyone with shell access to this machine has full access." That's the documented model — but it means:
- A browser tab on the same machine can hit `/api/*` via DNS rebinding or naive CSRF.
- Any other process on the box (including a compromised dependency in any other tool) can read all sessions and provider keys.
- Container escape, shared-host scenarios, or a future deployment where the API binds beyond localhost all silently lose auth.

Direction: at minimum, require the auth token on `/api/sessions/*` and `/api/auth` even from loopback so a same-origin attack model has *some* friction.

### 2.2 Provider proxy routes have no auth at all  **CRITICAL** (any non-loopback exposure)

File: `src/server/index.ts:39-45`

```ts
app.route('/or-proxy', openrouterProxy)
app.route('/venice-proxy', veniceProxy)
// ... 4 more
```

These are mounted **before** the auth middleware (line 52) and the comment says "no auth — openclaude calls these directly." If the API ever binds to anything but loopback, anyone reachable can use this server as a free relay to upstream providers, billed to the user's keys. This includes private-network exposure, Tailscale/VPN, or accidental `0.0.0.0` binds.

The proxy honors any auth header the caller sends and forwards everything else. So an attacker doesn't even need the user's keys — the proxy reads `provider_keys.json` server-side via the upstream calls inside the route handlers.

Wait — actually the Hono proxies forward whatever Authorization header the *caller* sends, so the attacker would need the user's key. But many of the proxies *also* call provider APIs server-side using stored keys (`messages.ts:262` — `Bearer ${apiKey}` from `getProviderApiKey`), so that path *does* burn the user's keys without the attacker possessing them.

Direction: require the auth token on all `/<provider>-proxy` routes too. Openclaude is a local subprocess that can pass the same token via env.

### 2.3 Upload + media-serve routes have no auth  **HIGH**

Files: `src/server/index.ts:47-49`, `src/server/routes/upload.ts:21-29`, `src/server/routes/media.ts:56-117`

`POST /api/upload` accepts up to 200 MB of arbitrary file types with no auth. `GET /api/attachments/:name` and `GET /api/media/serve?path=…` serve any file in an allowlist of directories (which includes `/tmp`, `~/Downloads`, `~/Pictures`, `~/.hermes/audio_cache`).

The `path=` query parameter on `/api/media/serve` is the most sensitive — anyone hitting that endpoint can read any file under those directories that they can guess the name of. `/tmp` in particular is dangerous: it's world-writable and contains temp files from many other processes.

Direction: same as 2.2 — require auth. Additionally, narrow `ALLOWED_ROOTS` in `media.ts:10-18` to *just* the webui's own dirs — `~/Pictures` and `~/Downloads` shouldn't be in there.

### 2.4 Token comparison is not constant-time  **MEDIUM**

File: `src/server/middleware/auth.ts:49`

```ts
if (!stored || token !== stored) {
```

The Python version (`api/auth.py:22`) used `secrets.compare_digest`. The TS version uses `!==` which is timing-attackable in principle. Mitigated by the 20-req/min rate limit, but rate-limit state is in-memory and resets on restart.

Direction: use `crypto.timingSafeEqual` after length-padding both sides.

### 2.5 Rate-limit state is in-memory only  **LOW**

File: `src/server/middleware/auth.ts:4-15`

The `rateLimits` Map is process-local. A determined attacker can ride a server restart to reset their counter. Also, `MAX_ATTEMPTS = 20` per minute lets you grind ~28k tries per day before lockout — feasible for a 6-character token.

Direction: persist rate-limit state, or aggressively scale exponential backoff after the first few failures.

### 2.6 IP detection has a soft fallback that bypasses auth  **MEDIUM**

File: `src/server/middleware/auth.ts:34-35`

```ts
const incoming = c.env?.['incoming'] as { socket?: { remoteAddress?: string } } | undefined
const ip = incoming?.socket?.remoteAddress ?? '127.0.0.1'
```

If Hono ever changes its node-server adapter to expose `incoming` differently (rename, restructure, drop entirely), `ip` silently falls to `'127.0.0.1'` and the loopback shortcut at line 37 lets every request through. Auth is one Hono breaking change away from being permanently disabled.

Direction: log a warning if `incoming` is missing and *deny* rather than allow.

### 2.7 `writeEnvFile` shell-escapes weakly  **MEDIUM**

File: `src/server/services/config.ts:100-109`

```ts
...Object.entries(env).map(([k, v]) => `export ${k}="${v}"`),
```

If a value contains a literal `"`, `$`, or backtick, the resulting file is broken or evaluates the substring. The user can write arbitrary text into env via the UI's API-key form (`POST /api/provider_keys`); a key with embedded quotes would land in `~/.env` and corrupt other tools that source it.

Direction: escape with `\\"` and `\\$`, or write JSON instead of shell.

### 2.8 No CSP, no `rehype-sanitize`  **MEDIUM**

Files: `dist/ui/index.html`, `package.json` deps

The bundle uses `react-markdown` + `rehype-highlight` to render assistant content. There is no `rehype-sanitize` in deps and no Content-Security-Policy header set anywhere. A malicious model output containing `<img onerror>` or a `javascript:` URL is the obvious XSS vector.

react-markdown is mostly safe by default in modern versions, but defense-in-depth is missing.

Direction: set CSP headers in the Hono app, add `rehype-sanitize` (when source is recoverable per §1.2).

### 2.9 External font dependency  **LOW**

File: `dist/ui/index.html:9-10`

Every page load makes requests to `fonts.googleapis.com` and `fonts.gstatic.com`. Privacy leak (Google logs every webui visit), and the UI degrades visually when offline.

Direction: self-host the two font families.

---

## 3. Data integrity & concurrency

### 3.1 Session writes have no atomicity  **HIGH**

File: `src/server/services/session.ts:22-24`

```ts
async function saveSession(session: Session): Promise<void> {
  await writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), 'utf-8')
}
```

Direct write to the destination file. If the process is killed during the write, the file is left half-written and the session becomes unparseable (`readSession` catches the JSON error and returns `null`, silently losing the entire session).

Direction: write to `<id>.json.tmp`, `fsync`, then `rename`.

### 3.2 Session writes have no locking  **HIGH**

Files: `src/server/services/session.ts:102-127` (`addMessage`), `src/server/routes/messages.ts` (multiple `addMessage` callers)

`addMessage` reads the session file, mutates the messages array, and writes the file back. There is no lock between read and write. Two near-simultaneous `addMessage` calls race:

```
T1: read session (5 messages)
T2: read session (5 messages)
T1: push message-A, write (6 messages)
T2: push message-B, write (6 messages, A is gone)
```

The webui itself can trigger this: `messages.ts` calls `addMessage` for the user message **fire-and-forget** (line 542 — `void addMessage(sessionId, 'user', content)`), then the SSE stream calls `addMessage` again for the assistant reply when `done` arrives. If the assistant response is fast enough, both writes overlap.

Direction: per-session async mutex around `addMessage`. Or move sessions to SQLite with WAL.

### 3.3 `createSession` returns before persistence  **MEDIUM**

File: `src/server/services/session.ts:73`

```ts
void saveSession(session)  // fire-and-forget
return session
```

Caller gets the session object before it's on disk. If the caller immediately calls `getSession(id)` (e.g., from a separate request triggered by the UI), it can return `null`. The webui is fast enough that this rarely lands, but it's a contract violation.

Direction: `await saveSession(session)` before returning.

### 3.4 Concurrent provider-keys writes can corrupt  **MEDIUM**

File: `src/server/services/config.ts:75-77`, `122-126`

Same race as 3.1/3.2 — `setProviderApiKey` does read-mod-write on `provider_keys.json` with no lock. Two simultaneous saves (e.g., user pastes keys for two providers and clicks save in rapid succession) can lose one.

Direction: same as 3.1 — write-to-temp-then-rename, plus a debounce/lock.

### 3.5 `searchSessions` reads every session file  **MEDIUM**

File: `src/server/services/session.ts:183-193`

```ts
return all.filter((s) => {
  if (s.title.toLowerCase().includes(q)) return true
  const full = getSession(s.id)
  if (!full) return false
  return full.messages.some((m) => m.content.toLowerCase().includes(q))
})
```

For N sessions with M messages each, this is O(N) disk reads + O(N×M) string scans on every keystroke (depending on how the UI debounces). At 200+ sessions with 100+ messages each, search noticeably stalls.

Direction: index titles + first-N chars of each message in a single in-memory index, refresh on writes.

### 3.6 `importSession` validates only the obvious fields  **MEDIUM**

File: `src/server/services/session.ts:230-275`

Validates `role`, `content`, `timestamp`. Does not validate `tool_calls`, `generated_media`, `attachments`, `system_prompt` length, or per-message size. An attacker who can hit `POST /api/sessions/import` can craft a session with malicious payloads in those fields that the renderer later trusts (e.g., a `generated_media` URL pointing at `javascript:` or a server-internal IP).

Direction: schema-validate the entire session shape (zod or similar) instead of hand-rolling.

### 3.7 `sessionPath` does not sanitize the id  **HIGH**

File: `src/server/services/session.ts:8-10`

```ts
function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`)
}
```

If `id` contains `../` or absolute path components, `join` does NOT prevent escape. A request to `GET /api/sessions/..%2F..%2Fetc%2Fpasswd.json` decodes to `id="../../etc/passwd"`, and `sessionPath` returns `/etc/passwd.json` (which doesn't exist, so the read fails — but the principle is broken). More dangerously, `DELETE /api/sessions/..%2Fsome-other-session` could delete an unrelated file.

Hono path params don't decode `%2F` by default in all configurations, so the practical exploit may be partial — but the validation should be explicit, not coincidental.

Direction: validate `id` matches a UUID regex before any `sessionPath` call.

### 3.8 No size limit on individual messages  **MEDIUM**

File: `src/server/routes/messages.ts:506-507`

The user message is taken from `body.message ?? body.content` and trimmed. No length cap. A 100MB pasted message goes into the session file, gets reread on every subsequent turn, and gets packed into the openclaude prompt (where the 200k token cap kicks in but only after the whole thing hits memory).

Direction: cap user message length (e.g., 1 MB) in `messages.ts` before saving.

---

## 4. Resource management & leaks

### 4.1 `activeRunners` Map grows without natural cleanup  **HIGH**

Files: `src/server/services/runner.ts:42`, `351-352`, `messages.ts:478-481`

`activeRunners` is only deleted from inside `cancelRunner`. `cancelRunner` is only called via:
- `stream.onAbort()` (client disconnects mid-stream)
- `POST /api/sessions/:id/cancel`
- `POST /api/restart`
- The first line of `startRunner` ("cancel any existing runner for this session")

When a runner finishes naturally — emits `result`, the for-await loop breaks on `done`, the `finally` block clears the keepalive — `cancelRunner` is **not** called. The dead Runner object stays in `activeRunners` forever, holding references to a dead `ChildProcess`, the async generator, the closure over `aborted`, etc.

Over a long uptime, this leaks. Also pollutes `getActiveRunners()` which is shown to the user — completed runners appear "active" until `proc.exitCode === null` is checked (line 444), but the dead ChildProcess objects are still memory.

Direction: in `messages.ts:478-481`, add `activeRunners.delete(sessionId)` on natural completion.

### 4.2 No global limit on concurrent openclaude processes  **MEDIUM**

File: `src/server/services/runner.ts:42`, `startRunner`

If a malicious or buggy client opens 100 SSE streams in 100 sessions, you get 100 spawned `openclaude` processes, each making upstream API calls and consuming memory. No queue, no per-session lock beyond the cancellation in `startRunner`, no global concurrency limit.

Per the user's CLAUDE.md, there's also a kernel-level constraint about parallel Node.js subprocesses on this machine (delayed_fput saturation). The webui has no awareness of that constraint.

Direction: queue spawns through a small async semaphore (e.g., max 4 concurrent).

### 4.3 SSE keepalive paired with no flush check  **MEDIUM**

File: `src/server/routes/messages.ts:406-413`

```ts
const keepalive = setInterval(() => {
  void stream.write(': keepalive\n\n')
}, 15_000)
```

If the client disconnected but `onAbort` hasn't fired yet (or never fires due to a transport edge case), this interval keeps writing forever. `void stream.write` swallows errors. Hono may eventually clean up but the timing isn't guaranteed.

Direction: track abort state explicitly and bail in the interval callback if aborted.

### 4.4 streamCache prunes only on cache miss  **MEDIUM**

File: `src/server/routes/proxyFactory.ts:169-181`

```ts
const streamCache = new Map<string, …>()
function pruneCache() { … }
```

`pruneCache()` is only called inside the `requiresStreaming` block when there's a cache miss. If a session never triggers `requiresStreaming` models, the cache never prunes. Same pattern in `veniceProxy.ts:34-40` for `mediaCache` (called only inside the image/video routing).

Direction: schedule pruning on a timer, or call it unconditionally on every request.

### 4.5 Sync I/O blocks the event loop  **MEDIUM**

Files: `src/server/routes/upload.ts:68`, `src/server/routes/media.ts:70`, `src/server/services/config.ts:69-77`

- `writeFileSync` of up to 50 MB blocks every other request during the write.
- `readFileSync` for media serving blocks during the read; for a 1 GB video this is ~hundreds of ms of unresponsiveness.
- Every `getProviderApiKey` call does `readFileSync` on `provider_keys.json`. Hot path on every request.

Direction: switch to `fs/promises`. Cache the keys with a debounced reload on writes.

### 4.6 Range request loads entire file into memory  **MEDIUM**

File: `src/server/routes/media.ts:68-93`

Range request parsing is correct, but `readFileSync(safePath)` reads the whole file *before* slicing. A 1 GB video with a 1 KB range request still loads 1 GB into memory.

Direction: open a stream and seek, or use `fs.createReadStream(safePath, { start, end })`.

### 4.7 No log rotation; warning spam fills disk  **MEDIUM**

Files: `start.sh:24` (`> "$LOG_DIR/api.log"`), `src/server/services/runner.ts:413` (`process.stderr.write`)

`api.log` grows unbounded. Before the auto-compact fix, openclaude was emitting the `[context] Warning: model not in integration model metadata` line thousands of times per request, ballooning logs to hundreds of KB per session. The log file is now smaller but still has no rotation policy.

Direction: rotate at 10 MB, keep last 3.

### 4.8 No body-size limit on proxy POSTs  **MEDIUM**

Files: `src/server/routes/proxyFactory.ts:221`, `veniceProxy.ts:180`, `anthropicProxy.ts:95`

```ts
bodyText = await c.req.text()
```

No limit. A malicious client (or a buggy openclaude that sends a runaway prompt) can stream gigabytes into memory.

Direction: cap at 5 MB or stream the body through.

---

## 5. Error handling & observability

### 5.1 Many `try/catch { /* ignore */ }` blocks swallow errors silently  **HIGH**

Examples:
- `messages.ts:24` (memory fetch fails → empty string, no log)
- `messages.ts:43, 60` (claude-mem init/summarize fails → silent)
- `proxyFactory.ts:281, 305` (JSON parse failure / cache write failure)
- `veniceProxy.ts:230, 251, 271` (3× silent fallthroughs)
- `session.ts:17-19` (corrupt session JSON returns null with no log)
- `config.ts:67-72` (corrupt config JSON returns fallback with no log)
- `upload.ts:32` (invalid form data → 400 but no log)

When something genuinely breaks, the log shows nothing. Debugging requires manual `process.stderr.write` insertion.

Direction: at least log the error to stderr in each catch arm. Even just `process.stderr.write(\`[location] ${err}\n\`)` is night-and-day better than `/* ignore */`.

### 5.2 Upstream `fetch` failures aren't caught in route handlers  **MEDIUM**

File: `src/server/routes/proxyFactory.ts:284-289`

```ts
const upstreamRes = await fetch(targetUrl, {
  method: c.req.method,
  headers: forwardHeaders,
  body: bodyText,
  signal: AbortSignal.timeout(600_000),
})
```

If the upstream is unreachable (DNS failure, network down, abort fires), `fetch` throws. Hono catches the throw and returns 500 with an empty body. The user sees "Internal Server Error" with no diagnostic info.

Direction: wrap in try/catch and return a JSON error explaining what happened.

### 5.3 `anthropicProxy` is not registered in `index.ts`  **HIGH**

Files: `src/server/routes/anthropicProxy.ts` (177 lines, fully implemented), `src/server/index.ts` (no import or `app.route`)

The Anthropic proxy file exists and is fully wired internally. It is not imported in `index.ts` and no `app.route('/anthropic-proxy', ...)` line exists. `PROXY_MAP` in `config.ts:22-28` does not list anthropic either.

This appears to be a regression from a prior merge. Per session memory, an earlier commit registered it; the upstream merge in `ddba45e` apparently didn't preserve that.

Effect: Anthropic models routed via the proxy path silently fail (they fall through to native Anthropic mode, which is exactly what the proxy was created to fix per the file's own header comment).

Direction: re-add the import and `app.route('/anthropic-proxy', anthropicProxy)`.

### 5.4 `anthropicProxy` doesn't translate tool calls  **MEDIUM**

File: `src/server/routes/anthropicProxy.ts:18-76`

The transform handles `message_start`, `content_block_delta` (text only), and `message_stop`. Anthropic's tool-use events (`content_block_start` with `tool_use`, `input_json_delta`, etc.) are dropped. If a user uses an Anthropic model with tools enabled, tool calls vanish.

Also `finish_reason: 'stop'` is hardcoded in the OAI translation — Anthropic's real `stop_reason` (could be `tool_use`, `max_tokens`, `end_turn`, etc.) is ignored.

Direction: translate the full Anthropic event set, or document explicitly that only text completions work.

### 5.5 SSE stream rewrite in `veniceProxy` doesn't buffer partial lines  **HIGH**

File: `src/server/routes/veniceProxy.ts:302-348`

```ts
async pull(controller) {
  while (true) {
    const { done, value } = await upstream.read()
    if (done) { controller.close(); return }
    const text = decoder.decode(value, { stream: true })
    const lines = text.split('\n')
    const out: string[] = []
    for (const line of lines) {
      // ... process each line
    }
    controller.enqueue(encoder.encode(out.join('\n')))
  }
}
```

Other SSE handlers in this codebase use the buffer + `lines.pop()` pattern to hold an incomplete trailing line until the next chunk arrives. This one doesn't. If a TCP packet split lands in the middle of a JSON event (which it will, eventually, on long reasoning streams), half of one event gets parsed (fails, falls through to "not a data line" path) and the rest joins the next chunk's first line, producing garbage.

Direction: same buffer + `pop()` pattern as `proxyFactory.ts:24-110` and `runner.ts:160-167`.

### 5.6 `stripClaudeIdentity` mangles legitimate user content  **MEDIUM**

Files: `src/server/routes/proxyFactory.ts:7-19`, `src/server/routes/veniceProxy.ts:152-164`

The regex replacements run on *all* system messages, but openclaude packs user conversation into the system prompt during tool-use rounds. A user asking "What's the difference between Claude Sonnet and GPT-4?" can have "Claude Sonnet" replaced with the Venice model name, silently corrupting the question.

Also `\\bOpenClaude\\b` is unconditional — anyone discussing OpenClaude as a project gets it rewritten too.

Direction: scope identity stripping to specific phrase patterns ("You are Claude…"), not generic word replacement.

### 5.7 `stripClaudeIdentity` is duplicated  **LOW**

Files: `proxyFactory.ts:7-19`, `veniceProxy.ts:152-164`

Two implementations of the same function with slightly different output strings. Drift waiting to happen.

Direction: move to a shared utility module, parametrize by provider name.

### 5.8 Process exit doesn't await in-flight requests  **MEDIUM**

File: `src/server/index.ts:110-117`

```ts
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down...')
  process.exit(0)
})
```

Immediate `process.exit(0)`. Active SSE streams get cut mid-response. The user sees a half-finished message.

Direction: close the Hono server, wait for in-flight to drain (with a deadline), then exit.

---

## 6. API correctness & robustness

### 6.1 `MEDIA:` prefix is a brittle convention  **MEDIUM**

Files: `src/server/routes/messages.ts:350-352`, `src/server/routes/veniceProxy.ts:219`

```ts
const mediaPrefix = content.match(/MEDIA:(\S+)/)
```

The Venice proxy emits `MEDIA:<url>` in the assistant content; the message route greps for that prefix to extract the URL. If the model ever emits `MEDIA:` naturally in conversation (e.g., quoting a config file), it gets parsed as a media URL.

Direction: use a structured field in the SSE event payload, not an in-band content prefix.

### 6.2 `inferModelType` regex is greedy  **MEDIUM**

File: `src/server/services/config.ts:169-178`

```ts
if (/flux|imagen|\bimage\b|imagine|stable[._-]diff|sdxl|hidream|aura|dall[._-]e|playground[._-]v|wai[._-]nsfw/i.test(id)) return 'image'
```

`\\bimage\\b` matches any model id with the word "image" — `grok-imagine-image` works, but a hypothetical `image-classification-7b` would also classify as image-gen. Audio/video patterns are similarly broad.

Direction: prefer the explicit `type` field set during discovery; treat regex inference as a last-resort fallback only.

### 6.3 `COST_MAP` is a 7-entry guess  **MEDIUM**

File: `src/server/services/config.ts:324-340`

Seven hardcoded patterns covering kimi, grok, llama, gemma, deepseek, claude. Anything else falls back to `1.0/4.0` per million tokens. The cost shown on each message is therefore wildly wrong for ~80% of models.

Direction: pull cost from a per-model JSON file populated during discovery, defaulting to "unknown" rather than a misleading guess.

### 6.4 Image generation dimensions are hardcoded  **LOW**

File: `src/server/routes/veniceProxy.ts:138`

`height: 1024, width: 1024`. No way to request other sizes.

Direction: parse dimensions from the user prompt, or expose a UI control.

### 6.5 Video poll loop is uncancelable  **MEDIUM**

File: `src/server/routes/veniceProxy.ts:107-130`

90 iterations × 10s polling for video gen. If the user closes the chat or cancels mid-poll, the loop keeps polling until completion or timeout. Wastes Venice quota.

Direction: hand `c.req.raw.signal` (or an AbortController hooked to the stream lifecycle) into the poll function.

### 6.6 Music polling is similarly uncancelable  **LOW**

File: `src/server/routes/messages.ts:178-215`

60 iterations × 10s poll for music gen. Same issue as 6.5.

### 6.7 OpenClaude binary path resolved at module load  **LOW**

File: `src/server/services/runner.ts:24`

```ts
const OPENCLAUDE_BIN = resolveOpenclaude()
```

Cached at import time. If openclaude is upgraded/moved/uninstalled, requests fail until server restart. Diagnostic message would be unhelpful (just "ENOENT").

Direction: resolve per-spawn, with a clear error when missing.

### 6.8 `PROXY_MAP` URLs hardcode port 8789  **LOW**

File: `src/server/services/config.ts:22-28`

```ts
export const PROXY_MAP: Record<string, string> = {
  openrouter: 'http://localhost:8789/or-proxy',
  // ...
}
```

The API port is configurable via `process.env.PORT` (`index.ts:22`) but the proxy URLs assume 8789. Changing the port leaves openclaude pointing at the wrong place.

Direction: build the URLs from `PORT` at startup, not as static strings.

### 6.9 `keepalive` SSE comment may not flush through Vite preview  **LOW**

File: `src/server/routes/messages.ts:406-408`

`vite preview` proxies `/api/*` via http-proxy. The default proxy doesn't aggressively flush small writes, so the 15s keepalive may buffer. In practice the streaming responses from real model calls flush enough to keep the connection alive, but it's an assumption worth noting.

### 6.10 `cancelRunner` doesn't kill openclaude's children  **MEDIUM**

File: `src/server/services/runner.ts:399-410`

`proc.kill('SIGTERM')` then `SIGKILL` — but signals sent to the immediate openclaude process don't propagate to grandchildren (e.g., subprocess Bash invocations from openclaude's tool-use). Orphan processes can outlive cancellation.

Direction: spawn with `detached: true` and kill the process group (`process.kill(-pid, 'SIGTERM')`).

### 6.11 `addModelEntry` writes a `base_url: ''` field that nothing reads  **LOW**

File: `src/server/services/config.ts:262`

Dead field. Same in `saveModels:276`.

---

## 7. Operational concerns

### 7.1 `start.sh` and `stop.sh` use `fuser -k` indiscriminately  **MEDIUM**

Files: `start.sh:17-18`, `stop.sh:15-16`

```bash
fuser -k "${API_PORT}/tcp" 2>/dev/null || true
```

Kills *anything* on those ports. If another app legitimately uses 8789 or 5173 (rare for 8789, very common for 5173 — that's Vite's default for any project), it gets killed.

Direction: kill only the saved PID. Use `fuser` only as a fallback after PID kill failed.

### 7.2 Race: kill PID, then `fuser -k` in stop.sh  **LOW**

File: `stop.sh:7-16`

After `kill PID`, the script falls through to `fuser -k` on the port. If between those two commands another process happens to bind that port (a fresh run of vite dev), it gets killed.

### 7.3 No port-conflict diagnostics  **LOW**

File: `start.sh:26-35`

If port 8789 is held by another process that survives `fuser -k` (root-owned, container, etc.), the loop times out with a generic "API failed to start" message.

### 7.4 `tsconfig.json` has `strict: false`  **HIGH**

File: `tsconfig.json:8`

TypeScript strictness is OFF. The 30 errors we surfaced after installing `@types/node` were the visible ones; many real type errors silently pass (missing null checks, implicit `any`, unchecked array access). This is the single biggest source of latent runtime bugs in the TS code.

Direction: enable `strict` family progressively (`strictNullChecks` first, then `noImplicitAny`, then full `strict`). Each adds 10-20 fixes' worth of work.

### 7.5 No tests at all on the live code  **HIGH**

Files: `e2e_test.py` (dead — points at the dead Python backend on port 8788)

There is zero coverage on `src/server/`. No unit tests, no integration tests, no contract tests against any provider proxy. Type checking now catches some classes of error after `@types/node`, but everything else relies on manual smoke testing.

Direction: even one happy-path integration test per provider would catch most of what tends to regress.

### 7.6 No process supervisor  **LOW**

File: `start.sh:22-24`

API server runs detached via `setsid`. If it crashes, nothing restarts it. The dead Python backend's `run.sh` had an auto-restart loop; the TS backend lost that.

Direction: a tiny supervisor wrapper, or a systemd user unit.

### 7.7 `npm run dev` is broken  **MEDIUM**

File: `package.json` scripts, missing `src/ui/`

`dev:ui` runs `vite --port 5173`, which serves from `src/ui/` — which is empty. `npm run dev` therefore can never have worked end-to-end since the frontend source was lost.

Direction: see §1.2.

### 7.8 Logs pid files committed to repo, then untracked  **LOW**

File: `.gitignore`, prior commit history

We just untracked `logs/`, `node_modules/`, `uploads/`. The history still contains them, including the dossier files that triggered our recent force-push. Anyone re-cloning still pulls historical bloat. (See `CHANGELOG.md` "Untrack" commit.)

Direction: optional `git filter-repo` to purge from history if disk-on-clone matters.

### 7.9 No health endpoint distinguishable from `/api/status`  **LOW**

File: `src/server/routes/status.ts:23-67`

`/api/status` is the only liveness endpoint, and it does heavy work (lists sessions, reads each one to compute totals). Cached for 5 s, but a load balancer health-checking on this would still trigger the cache-miss path.

Direction: add a `/api/healthz` that returns `200 OK` with no work.

---

## 8. Code quality & maintainability

### 8.1 `c.req.json<T>().catch(() => ({}))` repeated 8 times  **LOW**

Files: `messages.ts`, `models.ts`, `sessions.ts`, `status.ts`

Same pattern, each with its own type annotation. Now correctly typed (we just fixed it), but duplicated.

Direction: a one-line helper:
```ts
async function parseJson<T>(c: Context): Promise<T> {
  return c.req.json<T>().catch((): T => ({} as T))
}
```

### 8.2 Two `stripClaudeIdentity` implementations  **LOW**

See §5.7.

### 8.3 `MUSIC_MODEL_DEFAULTS` is exhaustive but `AUDIO_PROVIDER_DEFAULTS` is partial  **LOW**

Files: `src/server/services/config.ts:194-218`

Three TTS providers wired (openai, groq, venice). Other providers in `PROVIDER_MAP` (mistral, moonshot) silently can't do TTS even if the model is selectable.

Direction: explicit "audio not supported" error when picking an audio model on an unwired provider.

### 8.4 Several `as Record<string, unknown>` casts that could be narrowed  **LOW**

Files: throughout `proxyFactory.ts`, `veniceProxy.ts`, `runner.ts`, `messages.ts`

Heavy use of `as Record<string, unknown>` casts on parsed JSON, then `something['key'] as Type`. With `strict: false`, these cascade silently. With `strict: true` enabled (§7.4), they'd surface as places that need real type guards.

Direction: parse into typed shapes (zod) at the trust boundary; let the rest of the code work with concrete types.

### 8.5 `fetchMemoryContext`, `initMemSession`, `saveMemSummary` are tightly coupled to claude-mem  **LOW**

File: `src/server/routes/messages.ts:9-61`

Hardcoded `http://127.0.0.1:37777` and `openclaude-webui,johnny` projects. If claude-mem moves ports or projects rename, this silently fails to fetch memory (caught and ignored — see 5.1).

Direction: env-configurable URL, log on connect failure once, then back off.

### 8.6 `inferModelType` and `isMusicModel`/`isAudioInputModel` use overlapping regex  **LOW**

File: `src/server/services/config.ts:158-178`

Three regexes that depend on call order to resolve correctly. Easy to forget the precedence rule.

Direction: a single classifier that returns a typed result.

### 8.7 `messages.ts` is 580 lines and does five distinct things  **LOW**

File: `src/server/routes/messages.ts`

- Memory context fetching
- Music gen
- Audio (TTS) gen
- Image/video gen
- Text gen via runner
- SSE streaming

All in one file. Makes the file hard to navigate and reason about per-feature.

Direction: split media-gen into its own route file, leave text+SSE here.

---

## 9. Closing observations

### What's already pretty solid

- Token counting / packing in `buildConversationPrompt` (with the 200k cap) — the math is correct and the comments explain the why.
- The runner's stream-json parsing is comprehensive: handles `stream_event`, `assistant`, `result`, `error`, accumulates usage across tool rounds, dedups text. The recent fix for partial-output silent death (§§) is genuinely the right place.
- `auth.ts` rate limiting is a good thought even if the implementation has gaps.
- `media.ts` path safety check (`isPathSafe`) is correctly written; the issue is the allowlist breadth, not the algorithm.
- The proxy abstraction in `proxyFactory.ts` is clean and the per-provider proxies extend it sensibly.

### Highest leverage fixes

If I had to pick five things to do first:

1. **§1.1 — Delete the dead Python backend.** Pure cleanup. Removes confusion, halves the security review surface.
2. **§7.4 — Turn on `strict: true`.** Forces the language to flag the dozens of latent bugs hiding under `Record<string, unknown>` casts.
3. **§3.1 + §3.2 — Atomic session writes with a per-session lock.** This is the single biggest data-loss risk in normal operation.
4. **§4.1 — `delete activeRunners` on natural completion.** Two-line fix, kills the slow leak.
5. **§5.3 — Re-register `anthropicProxy`.** Real regression; fully implemented file is just disconnected.

### Highest leverage *re*-considerations

1. **§1.2 — Frontend source.** Decide where it lives. Whatever the answer, write it down.
2. **§2.1 / 2.2 / 2.3 — Auth model.** Document explicitly that the threat model is "single-user local-only," and either reinforce that (loopback-only bind, refuse non-loopback connections at the listener) or harden auth uniformly.
3. **§3 / §4 — Persistence layer.** SQLite would solve §3.1, §3.2, §3.4, §3.5 in one move. Probably worth considering before the codebase grows further.

End of sweep.
