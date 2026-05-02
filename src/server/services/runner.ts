import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readEnvFile, PROVIDER_MAP, PROXY_MAP, TOOL_MAP, getProviderApiKey, getModelEntry } from './config.js'

function resolveOpenclaude(): string {
  if (process.env.OPENCLAUDE_BIN && existsSync(process.env.OPENCLAUDE_BIN)) {
    return process.env.OPENCLAUDE_BIN
  }
  if (process.env.NVM_BIN) {
    const nvmPath = join(process.env.NVM_BIN, 'openclaude')
    if (existsSync(nvmPath)) return nvmPath
  }
  const npmGlobalPath = join(homedir(), '.npm-global/lib/node_modules/@gitlawb/openclaude/bin/openclaude')
  if (existsSync(npmGlobalPath)) return npmGlobalPath
  try {
    return execFileSync('which', ['openclaude'], { encoding: 'utf8' }).trim()
  } catch {
    return npmGlobalPath
  }
}

const OPENCLAUDE_BIN = resolveOpenclaude()

export type RunnerEvent =
  | { type: 'chunk'; content: string }
  | { type: 'error'; content: string }
  | { type: 'usage'; data: { input_tokens: number; output_tokens: number } }
  | { type: 'tool_start'; name: string; tool_id: string }
  | { type: 'tool_done'; name: string; tool_id: string; input: string }
  | { type: 'media'; url: string; media_type: 'image' | 'video'; alt?: string; width?: number; height?: number }
  | { type: 'done' }

export interface Runner {
  sessionId: string
  proc: ChildProcess
  cancel: () => void
  events: AsyncGenerator<RunnerEvent>
}

const activeRunners = new Map<string, Runner>()

function buildEnv(modelId: string): NodeJS.ProcessEnv {
  const env = { ...process.env }

  // Strip any leaked Anthropic keys from parent environment — must happen
  // before any fallback path that might re-inject them.
  delete env['ANTHROPIC_API_KEY']
  delete env['CLAUDE_API_KEY']
  delete env['ANTHROPIC_BASE_URL']

  // Parse provider and model from the session's model_id (e.g. "xai/grok-3")
  const slashIdx = modelId.indexOf('/')
  const provider = slashIdx !== -1 ? modelId.slice(0, slashIdx) : ''
  const modelEntry = getModelEntry(modelId)
  const model = modelEntry?.model ?? (slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId)
  const caps = modelEntry?.capabilities

  const apiKey = provider ? getProviderApiKey(provider) : null
  const providerMeta = provider ? PROVIDER_MAP[provider] : null
  const baseUrl = PROXY_MAP[provider] ?? providerMeta?.base_url ?? ''

  if (apiKey && provider === 'anthropic' && model) {
    // Native Anthropic mode — openclaude IS an Anthropic agent. Do NOT set
    // OPENAI_BASE_URL; let the CLI use its built-in Anthropic client.
    env['ANTHROPIC_API_KEY'] = apiKey
    env['ANTHROPIC_MODEL'] = model
    delete env['CLAUDE_CODE_USE_OPENAI']
    delete env['OPENAI_API_KEY']
    delete env['OPENAI_BASE_URL']
    delete env['OPENAI_MODEL']
    delete env['VENICE_MODEL_NAME']
    delete env['VENICE_UNCENSORED']
    delete env['VENICE_DISABLE_THINKING']
    if (caps && caps.tools === false) env['OC_DISABLE_TOOLS'] = '1'
    else delete env['OC_DISABLE_TOOLS']
  } else if (apiKey && baseUrl && model) {
    env['CLAUDE_CODE_USE_OPENAI'] = '1'
    env['OPENAI_API_KEY'] = apiKey
    env['OPENAI_BASE_URL'] = baseUrl
    env['OPENAI_MODEL'] = model
    if (provider === 'venice') {
      env['VENICE_MODEL_NAME'] = model
      env['VENICE_UNCENSORED'] = 'true'
      // Disable thinking for models that don't support it
      if (caps && caps.thinking === false) {
        env['VENICE_DISABLE_THINKING'] = 'true'
      }
    } else {
      delete env['VENICE_MODEL_NAME']
      delete env['VENICE_UNCENSORED']
      delete env['VENICE_DISABLE_THINKING']
    }
    // Signal to runner that tools should be stripped for models that don't support them
    if (caps && caps.tools === false) {
      env['OC_DISABLE_TOOLS'] = '1'
    } else {
      delete env['OC_DISABLE_TOOLS']
    }
  } else {
    // Fallback: read from ~/.env (e.g. on first boot before any switch)
    const fileEnv = readEnvFile()
    Object.assign(env, fileEnv)
    // Belt-and-suspenders: re-strip Anthropic keys after fileEnv merge
    delete env['ANTHROPIC_API_KEY']
    delete env['CLAUDE_API_KEY']
    delete env['ANTHROPIC_BASE_URL']
  }

  // Inject tool API keys so openclaude can use Apify, Firecrawl, etc.
  for (const [toolId, meta] of Object.entries(TOOL_MAP)) {
    const key = getProviderApiKey(toolId)
    if (key) env[meta.env_key] = key
  }

  env['CLAUDE_CONFIG_DIR'] = join(homedir(), '.openclaw-openclaude')
  env['FORCE_COLOR'] = '0'
  env['TERM'] = 'dumb'
  return env
}

async function* readEvents(
  proc: ChildProcess,
  aborted: { value: boolean },
  stderrTail: () => string
): AsyncGenerator<RunnerEvent> {
  let buffer = ''
  let emitted = ''
  let anyEmitted = false  // survives message_stop resets — guards assistant fallback
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let resultSeen = false
  // Tracks in-progress tool_use content blocks by their stream index
  const toolBlocks = new Map<number, { name: string; id: string; inputBuffer: string }>()

  const stdout = proc.stdout
  if (!stdout) return

  for await (const chunk of stdout) {
    if (aborted.value) break

    buffer += chunk as string

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue

      let data: Record<string, unknown>
      try {
        data = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      const eventType = data['type'] as string

      if (eventType === 'system') continue

      if (eventType === 'stream_event') {
        const event = data['event'] as Record<string, unknown> | undefined
        const evType = event?.['type'] as string | undefined

        if (evType === 'content_block_start') {
          const index = event?.['index'] as number | undefined
          const block = event?.['content_block'] as Record<string, unknown> | undefined
          if (block?.['type'] === 'tool_use' && index !== undefined) {
            const name = (block['name'] as string) ?? 'unknown'
            const toolId = (block['id'] as string) ?? ''
            toolBlocks.set(index, { name, id: toolId, inputBuffer: '' })
            yield { type: 'tool_start', name, tool_id: toolId }
          } else if (block?.['type'] === 'image') {
            // Image generation model output — extract URL from the block
            const source = block['source'] as Record<string, unknown> | undefined
            const imageUrl = (source?.['url'] as string) ?? (block['url'] as string) ?? ''
            if (imageUrl) {
              yield {
                type: 'media',
                url: imageUrl,
                media_type: 'image',
                alt: (block['alt'] as string) ?? undefined,
                width: (block['width'] as number) ?? undefined,
                height: (block['height'] as number) ?? undefined,
              }
            }
          } else if (block?.['type'] === 'video') {
            const source = block['source'] as Record<string, unknown> | undefined
            const videoUrl = (source?.['url'] as string) ?? (block['url'] as string) ?? ''
            if (videoUrl) {
              yield {
                type: 'media',
                url: videoUrl,
                media_type: 'video',
                alt: (block['alt'] as string) ?? undefined,
              }
            }
          }
        } else if (evType === 'content_block_delta') {
          const index = event?.['index'] as number | undefined
          const delta = event?.['delta'] as Record<string, unknown> | undefined
          if (delta?.['type'] === 'text_delta') {
            const text = delta['text'] as string
            if (text) {
              // Dedup: only emit what's new
              if (text.startsWith(emitted)) {
                const newPart = text.slice(emitted.length)
                if (newPart) {
                  yield { type: 'chunk', content: newPart }
                  emitted += newPart
                  anyEmitted = true
                }
              } else {
                yield { type: 'chunk', content: text }
                emitted += text
                anyEmitted = true
              }
            }
          } else if (delta?.['type'] === 'input_json_delta' && index !== undefined) {
            const tool = toolBlocks.get(index)
            if (tool) {
              tool.inputBuffer += (delta['partial_json'] as string) ?? ''
            }
          }
        } else if (evType === 'content_block_stop') {
          const index = event?.['index'] as number | undefined
          if (index !== undefined) {
            const tool = toolBlocks.get(index)
            if (tool) {
              yield { type: 'tool_done', name: tool.name, tool_id: tool.id, input: tool.inputBuffer }
              toolBlocks.delete(index)
            }
          }
        } else if (evType === 'message_stop') {
          // Accumulate usage across all tool-call rounds — do NOT return here.
          // message_stop fires after each model turn; result fires when the whole task is done.
          const usage = (event?.['message'] as Record<string, unknown> | undefined)?.[
            'usage'
          ] as { input_tokens?: number; output_tokens?: number } | undefined
          if (usage) {
            totalInputTokens += usage.input_tokens ?? 0
            totalOutputTokens += usage.output_tokens ?? 0
          }
          // Reset dedup and any incomplete tool blocks between model turns
          emitted = ''
          toolBlocks.clear()
        }
        continue
      }

      if (eventType === 'assistant') {
        // For most models, content_block_delta events already delivered all text.
        // But some providers (e.g. kimi via Venice/SiliconFlow) never emit content_block_delta —
        // the content only appears here. Emit it if nothing came through streaming deltas.
        // Use anyEmitted (not emitted) — message_stop resets emitted between turns but we
        // must not re-emit content that was already streamed in a prior turn.
        if (!anyEmitted) {
          const msg = data['message'] as Record<string, unknown> | undefined
          const contentBlocks = msg?.['content']
          if (typeof contentBlocks === 'string' && contentBlocks.trim()) {
            yield { type: 'chunk', content: contentBlocks }
            emitted += contentBlocks
            anyEmitted = true
          } else if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
              const b = block as Record<string, unknown>
              if (b['type'] === 'text') {
                const text = b['text'] as string
                if (text?.trim()) {
                  yield { type: 'chunk', content: text }
                  emitted += text
                  anyEmitted = true
                }
              } else if (b['type'] === 'image' || b['type'] === 'image_url') {
                const imageUrl = (b['image_url'] as Record<string, unknown>)?.url as string
                  ?? (b['source'] as Record<string, unknown>)?.url as string
                  ?? (b['url'] as string)
                  ?? ''
                if (imageUrl) {
                  yield {
                    type: 'media',
                    url: imageUrl,
                    media_type: 'image',
                    alt: (b['alt'] as string) ?? undefined,
                  }
                }
              }
            }
          }
        }
        continue
      }

      if (eventType === 'result') {
        resultSeen = true
        if (totalInputTokens > 0 || totalOutputTokens > 0) {
          yield { type: 'usage', data: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens } }
        }
        yield { type: 'done' }
        return
      }

      if (eventType === 'error') {
        yield { type: 'error', content: (data['message'] as string) ?? 'Unknown error' }
        yield { type: 'done' }
        return
      }
    }
  }

  // stdout closed without a result event — openclaude exited (or crashed) early.
  // If nothing was streamed, surface the failure with stderr context so the UI
  // doesn't render a phantom empty turn.
  if (!resultSeen && !aborted.value) {
    const exitCode = proc.exitCode
    const tail = stderrTail()
    if (!anyEmitted) {
      const summary = tail.trim() || `openclaude exited (code ${exitCode ?? 'unknown'}) with no output`
      yield { type: 'error', content: summary.slice(-2000) }
    } else if (tail.trim()) {
      // Partial output then crash — log the tail for diagnostics
      process.stderr.write(`[runner] openclaude exited mid-stream (code ${exitCode}); stderr tail:\n${tail.slice(-2000)}\n`)
    }
  }

  yield { type: 'done' }
}

const PRESET_SUFFIX: Record<string, string> = {
  precise: 'Respond with precision and accuracy. Be concise and factual. Avoid speculation.',
  creative: 'Feel free to be creative, exploratory, and imaginative in your responses.',
}

function buildEffectiveSystemPrompt(
  systemPrompt?: string,
  temperaturePreset?: string
): string | null {
  const parts: string[] = []
  if (systemPrompt?.trim()) parts.push(systemPrompt.trim())
  const suffix = temperaturePreset ? PRESET_SUFFIX[temperaturePreset] : undefined
  if (suffix) parts.push(suffix)
  return parts.length ? parts.join('\n\n') : null
}

export function startRunner(
  sessionId: string,
  modelId: string,
  message: string,
  options: { systemPrompt?: string; temperaturePreset?: string } = {}
): Runner {
  cancelRunner(sessionId)

  const env = buildEnv(modelId)
  const effectivePrompt = buildEffectiveSystemPrompt(options.systemPrompt, options.temperaturePreset)

  const cmd = [
    OPENCLAUDE_BIN,
    '--print',
    '--verbose',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--permission-mode', 'bypassPermissions',
    '--bare',
  ]

  if (effectivePrompt) {
    cmd.push('--append-system-prompt', effectivePrompt)
  }

  const proc = spawn(cmd[0], cmd.slice(1), {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  })

  // Capture stderr (capped) so silent crashes surface in the API log AND in
  // the SSE error event readEvents emits when openclaude exits without
  // producing a `result` event. Without this, xAI/upstream failures look like
  // empty assistant turns to the user.
  const STDERR_CAP = 16_384
  let stderrBuf = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    stderrBuf += chunk
    if (stderrBuf.length > STDERR_CAP) {
      stderrBuf = stderrBuf.slice(-STDERR_CAP)
    }
    process.stderr.write(`[openclaude:${sessionId.slice(0, 8)}] ${chunk}`)
  })

  const aborted = { value: false }

  const cancel = () => {
    aborted.value = true
    if (proc.exitCode === null) {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      setTimeout(() => {
        if (proc.exitCode === null) {
          try { proc.kill('SIGKILL') } catch { /* ignore */ }
        }
      }, 1500)
    }
    activeRunners.delete(sessionId)
  }

  if (proc.stdin) {
    proc.stdin.write(message + '\n')
    proc.stdin.end()
  }

  const runner: Runner = {
    sessionId,
    proc,
    cancel,
    events: readEvents(proc, aborted, () => stderrBuf),
  }

  activeRunners.set(sessionId, runner)
  return runner
}

export function getRunner(sessionId: string): Runner | undefined {
  return activeRunners.get(sessionId)
}

export function cancelRunner(sessionId: string): void {
  const r = activeRunners.get(sessionId)
  if (r) {
    r.cancel()
    activeRunners.delete(sessionId)
  }
}

export function getActiveRunners(): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const [id, r] of activeRunners.entries()) {
    result[id] = r.proc.exitCode === null
  }
  return result
}
