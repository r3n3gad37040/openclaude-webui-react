import { spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readEnvFile, PROVIDER_MAP, PROXY_MAP, TOOL_MAP, getProviderApiKey, getModelEntry } from './config.js';
function resolveOpenclaude() {
    if (process.env.OPENCLAUDE_BIN && existsSync(process.env.OPENCLAUDE_BIN)) {
        return process.env.OPENCLAUDE_BIN;
    }
    if (process.env.NVM_BIN) {
        const nvmPath = join(process.env.NVM_BIN, 'openclaude');
        if (existsSync(nvmPath))
            return nvmPath;
    }
    const npmGlobalPath = join(homedir(), '.npm-global/lib/node_modules/@gitlawb/openclaude/bin/openclaude');
    if (existsSync(npmGlobalPath))
        return npmGlobalPath;
    try {
        return execFileSync('which', ['openclaude'], { encoding: 'utf8' }).trim();
    }
    catch {
        return npmGlobalPath;
    }
}
const OPENCLAUDE_BIN = resolveOpenclaude();
const activeRunners = new Map();
// Hard cap on concurrent openclaude subprocesses. Single-user app, so even 8
// is a luxurious ceiling; the real purpose is to bound runaway behavior
// (buggy client opening 100 streams) rather than gate legitimate use.
const MAX_CONCURRENT_RUNNERS = parseInt(process.env['MAX_CONCURRENT_RUNNERS'] ?? '8');
function buildEnv(modelId) {
    const env = { ...process.env };
    // Strip any leaked Anthropic keys from parent environment — must happen
    // before any fallback path that might re-inject them.
    delete env['ANTHROPIC_API_KEY'];
    delete env['CLAUDE_API_KEY'];
    delete env['ANTHROPIC_BASE_URL'];
    // Parse provider and model from the session's model_id (e.g. "xai/grok-3")
    const slashIdx = modelId.indexOf('/');
    const provider = slashIdx !== -1 ? modelId.slice(0, slashIdx) : '';
    const modelEntry = getModelEntry(modelId);
    const model = modelEntry?.model ?? (slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId);
    const caps = modelEntry?.capabilities;
    const apiKey = provider ? getProviderApiKey(provider) : null;
    const providerMeta = provider ? PROVIDER_MAP[provider] : null;
    const baseUrl = PROXY_MAP[provider] ?? providerMeta?.base_url ?? '';
    if (apiKey && provider === 'anthropic' && model) {
        // Native Anthropic mode — openclaude IS an Anthropic agent. Do NOT set
        // OPENAI_BASE_URL; let the CLI use its built-in Anthropic client.
        env['ANTHROPIC_API_KEY'] = apiKey;
        env['ANTHROPIC_MODEL'] = model;
        delete env['CLAUDE_CODE_USE_OPENAI'];
        delete env['OPENAI_API_KEY'];
        delete env['OPENAI_BASE_URL'];
        delete env['OPENAI_MODEL'];
        delete env['VENICE_MODEL_NAME'];
        delete env['VENICE_UNCENSORED'];
        delete env['VENICE_DISABLE_THINKING'];
        if (caps && caps.tools === false)
            env['OC_DISABLE_TOOLS'] = '1';
        else
            delete env['OC_DISABLE_TOOLS'];
    }
    else if (apiKey && baseUrl && model) {
        env['CLAUDE_CODE_USE_OPENAI'] = '1';
        env['OPENAI_API_KEY'] = apiKey;
        env['OPENAI_BASE_URL'] = baseUrl;
        env['OPENAI_MODEL'] = model;
        if (provider === 'venice') {
            env['VENICE_MODEL_NAME'] = model;
            env['VENICE_UNCENSORED'] = 'true';
            // Disable thinking for models that don't support it
            if (caps && caps.thinking === false) {
                env['VENICE_DISABLE_THINKING'] = 'true';
            }
        }
        else {
            delete env['VENICE_MODEL_NAME'];
            delete env['VENICE_UNCENSORED'];
            delete env['VENICE_DISABLE_THINKING'];
        }
        // Signal to runner that tools should be stripped for models that don't support them
        if (caps && caps.tools === false) {
            env['OC_DISABLE_TOOLS'] = '1';
        }
        else {
            delete env['OC_DISABLE_TOOLS'];
        }
    }
    else {
        // Fallback: read from ~/.env (e.g. on first boot before any switch)
        const fileEnv = readEnvFile();
        Object.assign(env, fileEnv);
        // Belt-and-suspenders: re-strip Anthropic keys after fileEnv merge
        delete env['ANTHROPIC_API_KEY'];
        delete env['CLAUDE_API_KEY'];
        delete env['ANTHROPIC_BASE_URL'];
    }
    // Inject tool API keys so openclaude can use Apify, Firecrawl, etc.
    for (const [toolId, meta] of Object.entries(TOOL_MAP)) {
        const key = getProviderApiKey(toolId);
        if (key)
            env[meta.env_key] = key;
    }
    // Prevent the openclaude CLI from aborting long-running requests.
    // Deepseek via OpenRouter routinely exceeds the 60 s default timeout.
    env['API_TIMEOUT_MS'] = env['API_TIMEOUT_MS'] || '600000';
    // The webui freshly spawns openclaude per turn with the full packed history,
    // so the CLI's internal auto-compact never has anything to summarize — but it
    // still triggers (assuming a 128k window for unknown models) and fires a
    // same-model summarization API call that silently kills long-horizon turns.
    env['DISABLE_AUTO_COMPACT'] = '1';
    env['DISABLE_COMPACT'] = '1';
    // Tell openclaude the real context window for the active model so it stops
    // assuming the conservative 128k fallback (and stops spamming stderr with the
    // "[context] Warning: model not in integration model metadata" line on every
    // token-count check).
    const ctxWindow = modelEntry?.context_window;
    if (ctxWindow && ctxWindow > 0) {
        env['CLAUDE_CODE_OPENAI_FALLBACK_CONTEXT_WINDOW'] = String(ctxWindow);
    }
    env['CLAUDE_CONFIG_DIR'] = join(homedir(), '.openclaw-openclaude');
    env['FORCE_COLOR'] = '0';
    env['TERM'] = 'dumb';
    return env;
}
async function* readEvents(proc, aborted, stderrTail) {
    let buffer = '';
    let emitted = '';
    let anyEmitted = false; // survives message_stop resets — guards assistant fallback
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let resultSeen = false;
    // Tracks in-progress tool_use content blocks by their stream index
    const toolBlocks = new Map();
    const stdout = proc.stdout;
    if (!stdout)
        return;
    for await (const chunk of stdout) {
        if (aborted.value)
            break;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
            const line = raw.trim();
            if (!line)
                continue;
            let data;
            try {
                data = JSON.parse(line);
            }
            catch {
                continue;
            }
            const eventType = data['type'];
            if (eventType === 'system')
                continue;
            if (eventType === 'stream_event') {
                const event = data['event'];
                const evType = event?.['type'];
                if (evType === 'content_block_start') {
                    const index = event?.['index'];
                    const block = event?.['content_block'];
                    if (block?.['type'] === 'tool_use' && index !== undefined) {
                        const name = block['name'] ?? 'unknown';
                        const toolId = block['id'] ?? '';
                        toolBlocks.set(index, { name, id: toolId, inputBuffer: '' });
                        yield { type: 'tool_start', name, tool_id: toolId };
                    }
                    else if (block?.['type'] === 'image') {
                        // Image generation model output — extract URL from the block
                        const source = block['source'];
                        const imageUrl = source?.['url'] ?? block['url'] ?? '';
                        if (imageUrl) {
                            yield {
                                type: 'media',
                                url: imageUrl,
                                media_type: 'image',
                                alt: block['alt'] ?? undefined,
                                width: block['width'] ?? undefined,
                                height: block['height'] ?? undefined,
                            };
                        }
                    }
                    else if (block?.['type'] === 'video') {
                        const source = block['source'];
                        const videoUrl = source?.['url'] ?? block['url'] ?? '';
                        if (videoUrl) {
                            yield {
                                type: 'media',
                                url: videoUrl,
                                media_type: 'video',
                                alt: block['alt'] ?? undefined,
                            };
                        }
                    }
                }
                else if (evType === 'content_block_delta') {
                    const index = event?.['index'];
                    const delta = event?.['delta'];
                    if (delta?.['type'] === 'text_delta') {
                        const text = delta['text'];
                        if (text) {
                            // Dedup: only emit what's new
                            if (text.startsWith(emitted)) {
                                const newPart = text.slice(emitted.length);
                                if (newPart) {
                                    yield { type: 'chunk', content: newPart };
                                    emitted += newPart;
                                    anyEmitted = true;
                                }
                            }
                            else {
                                yield { type: 'chunk', content: text };
                                emitted += text;
                                anyEmitted = true;
                            }
                        }
                    }
                    else if (delta?.['type'] === 'input_json_delta' && index !== undefined) {
                        const tool = toolBlocks.get(index);
                        if (tool) {
                            tool.inputBuffer += delta['partial_json'] ?? '';
                        }
                    }
                }
                else if (evType === 'content_block_stop') {
                    const index = event?.['index'];
                    if (index !== undefined) {
                        const tool = toolBlocks.get(index);
                        if (tool) {
                            yield { type: 'tool_done', name: tool.name, tool_id: tool.id, input: tool.inputBuffer };
                            toolBlocks.delete(index);
                        }
                    }
                }
                else if (evType === 'message_stop') {
                    // Accumulate usage across all tool-call rounds — do NOT return here.
                    // message_stop fires after each model turn; result fires when the whole task is done.
                    const usage = event?.['message']?.['usage'];
                    if (usage) {
                        totalInputTokens += usage.input_tokens ?? 0;
                        totalOutputTokens += usage.output_tokens ?? 0;
                    }
                    // Reset dedup and any incomplete tool blocks between model turns
                    emitted = '';
                    toolBlocks.clear();
                }
                continue;
            }
            if (eventType === 'assistant') {
                // For most models, content_block_delta events already delivered all text.
                // But some providers (e.g. kimi via Venice/SiliconFlow) never emit content_block_delta —
                // the content only appears here. Emit it if nothing came through streaming deltas.
                // Use anyEmitted (not emitted) — message_stop resets emitted between turns but we
                // must not re-emit content that was already streamed in a prior turn.
                if (!anyEmitted) {
                    const msg = data['message'];
                    const contentBlocks = msg?.['content'];
                    if (typeof contentBlocks === 'string' && contentBlocks.trim()) {
                        yield { type: 'chunk', content: contentBlocks };
                        emitted += contentBlocks;
                        anyEmitted = true;
                    }
                    else if (Array.isArray(contentBlocks)) {
                        for (const block of contentBlocks) {
                            const b = block;
                            if (b['type'] === 'text') {
                                const text = b['text'];
                                if (text?.trim()) {
                                    yield { type: 'chunk', content: text };
                                    emitted += text;
                                    anyEmitted = true;
                                }
                            }
                            else if (b['type'] === 'image' || b['type'] === 'image_url') {
                                const imageUrl = b['image_url']?.url
                                    ?? b['source']?.url
                                    ?? b['url']
                                    ?? '';
                                if (imageUrl) {
                                    yield {
                                        type: 'media',
                                        url: imageUrl,
                                        media_type: 'image',
                                        alt: b['alt'] ?? undefined,
                                    };
                                }
                            }
                        }
                    }
                }
                continue;
            }
            if (eventType === 'result') {
                resultSeen = true;
                if (totalInputTokens > 0 || totalOutputTokens > 0) {
                    yield { type: 'usage', data: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens } };
                }
                yield { type: 'done' };
                return;
            }
            if (eventType === 'error') {
                yield { type: 'error', content: data['message'] ?? 'Unknown error' };
                yield { type: 'done' };
                return;
            }
        }
    }
    // stdout closed without a result event — openclaude exited (or crashed) early.
    // Surface the failure to the user in BOTH cases (no output at all, or partial
    // stream then silent death) so the UI never renders a half-complete turn that
    // looks like the model just stopped talking. Previously the partial-output
    // case only logged server-side, which is exactly the silent-disconnect bug.
    if (!resultSeen && !aborted.value) {
        const exitCode = proc.exitCode;
        const tail = stderrTail();
        if (!anyEmitted) {
            const summary = tail.trim() || `openclaude exited (code ${exitCode ?? 'unknown'}) with no output`;
            yield { type: 'error', content: summary.slice(-2000) };
        }
        else {
            process.stderr.write(`[runner] openclaude exited mid-stream (code ${exitCode}); stderr tail:\n${tail.slice(-2000)}\n`);
            const reason = tail.trim().slice(-500) || `exit code ${exitCode ?? 'unknown'}`;
            yield { type: 'error', content: `[response cut off mid-stream — ${reason}]` };
        }
    }
    yield { type: 'done' };
}
const PRESET_SUFFIX = {
    precise: 'Respond with precision and accuracy. Be concise and factual. Avoid speculation.',
    creative: 'Feel free to be creative, exploratory, and imaginative in your responses.',
};
function buildEffectiveSystemPrompt(systemPrompt, temperaturePreset) {
    const parts = [];
    if (systemPrompt?.trim())
        parts.push(systemPrompt.trim());
    const suffix = temperaturePreset ? PRESET_SUFFIX[temperaturePreset] : undefined;
    if (suffix)
        parts.push(suffix);
    return parts.length ? parts.join('\n\n') : null;
}
// Synthetic "runner" for refused spawns — emits a single error event so
// the SSE handler can surface a clear message to the user instead of
// crashing the response stream.
async function* errorEvents(message) {
    yield { type: 'error', content: message };
    yield { type: 'done' };
}
export function startRunner(sessionId, modelId, message, options = {}) {
    cancelRunner(sessionId);
    // Concurrency cap. Counted AFTER cancelling any existing runner for this
    // session so a re-send doesn't double-count.
    if (activeRunners.size >= MAX_CONCURRENT_RUNNERS) {
        return {
            sessionId,
            proc: { exitCode: 1 },
            cancel: () => { },
            events: errorEvents(`Too many concurrent model runs (${activeRunners.size}/${MAX_CONCURRENT_RUNNERS}). Wait for an existing one to finish or cancel it.`),
        };
    }
    const env = buildEnv(modelId);
    const effectivePrompt = buildEffectiveSystemPrompt(options.systemPrompt, options.temperaturePreset);
    const cmd = [
        OPENCLAUDE_BIN,
        '--print',
        '--verbose',
        '--output-format=stream-json',
        '--include-partial-messages',
        '--permission-mode', 'bypassPermissions',
        '--bare',
    ];
    if (effectivePrompt) {
        cmd.push('--append-system-prompt', effectivePrompt);
    }
    const [bin, ...args] = cmd;
    if (!bin)
        throw new Error('runner: empty command');
    // detached:true puts openclaude in its own process group so we can SIGKILL
    // the whole group on cancel — kills any tool-use grandchildren openclaude
    // may have spawned (Bash, etc.) instead of orphaning them.
    const proc = spawn(bin, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
    });
    // Capture stderr (capped) so silent crashes surface in the API log AND in
    // the SSE error event readEvents emits when openclaude exits without
    // producing a `result` event. Without this, xAI/upstream failures look like
    // empty assistant turns to the user.
    const STDERR_CAP = 16384;
    let stderrBuf = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk) => {
        stderrBuf += chunk;
        if (stderrBuf.length > STDERR_CAP) {
            stderrBuf = stderrBuf.slice(-STDERR_CAP);
        }
        process.stderr.write(`[openclaude:${sessionId.slice(0, 8)}] ${chunk}`);
    });
    const aborted = { value: false };
    // Kill the whole process group (negative PID) so tool-use grandchildren
    // die with the parent.
    const killGroup = (sig) => {
        if (proc.pid === undefined)
            return;
        try {
            process.kill(-proc.pid, sig);
        }
        catch { /* group may already be gone */ }
    };
    const cancel = () => {
        aborted.value = true;
        if (proc.exitCode === null) {
            killGroup('SIGTERM');
            setTimeout(() => {
                if (proc.exitCode === null)
                    killGroup('SIGKILL');
            }, 1500);
        }
        activeRunners.delete(sessionId);
    };
    // Natural completion: when the child exits, drop it from the active map
    // so the SSE handler's "successful done" path doesn't leave a dangling
    // entry in activeRunners forever. (Previously only cancel() removed.)
    proc.once('exit', () => {
        activeRunners.delete(sessionId);
    });
    if (proc.stdin) {
        proc.stdin.write(message + '\n');
        proc.stdin.end();
    }
    const runner = {
        sessionId,
        proc,
        cancel,
        events: readEvents(proc, aborted, () => stderrBuf),
    };
    activeRunners.set(sessionId, runner);
    return runner;
}
export function getRunner(sessionId) {
    return activeRunners.get(sessionId);
}
export function cancelRunner(sessionId) {
    const r = activeRunners.get(sessionId);
    if (r) {
        r.cancel();
        activeRunners.delete(sessionId);
    }
}
export function getActiveRunners() {
    const result = {};
    for (const [id, r] of activeRunners.entries()) {
        result[id] = r.proc.exitCode === null;
    }
    return result;
}
