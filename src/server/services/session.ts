import { readFileSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { writeFile, rename } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { SESSIONS_DIR } from './config.js'
import type { Session, SessionSummary, Message, TemperaturePreset } from '../../types/index.js'

// ─── Per-session async mutex ─────────────────────────────────────────────
// Two near-simultaneous writes to the same session.json (e.g. user message
// fire-and-forget save racing the assistant-reply save) can lose one of
// them. Serialize per-id so reads always see consistent state.
const sessionLocks = new Map<string, Promise<unknown>>()
function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(id) ?? Promise.resolve()
  const next = prev.then(fn, fn)  // run fn whether prev resolved or rejected
  // Track only completion (never reject the lock chain itself).
  sessionLocks.set(id, next.catch(() => undefined))
  return next
}

// UUIDs are the only valid session ids — created via randomUUID() and never
// user-supplied. Reject anything else so a malicious client can't smuggle
// path-traversal sequences (`../`) through `/api/sessions/:id` routes and
// read or delete files outside SESSIONS_DIR.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sessionPath(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid session id: ${id}`)
  }
  return join(SESSIONS_DIR, `${id}.json`)
}

function readSession(id: string): Session | null {
  let p: string
  try {
    p = sessionPath(id)
  } catch {
    return null
  }
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Session
  } catch (err) {
    process.stderr.write(`[session] readSession(${id}) parse failed: ${err}\n`)
    return null
  }
}

// Atomic write: tmp file + rename. If the process dies mid-write, the
// destination still holds the previous valid JSON instead of a half-written
// blob that readSession would silently treat as a missing session.
async function saveSession(session: Session): Promise<void> {
  const dest = sessionPath(session.id)
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(session, null, 2), 'utf-8')
  await rename(tmp, dest)
}

export function listSessions(): SessionSummary[] {
  let files: string[]
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  const sessions: SessionSummary[] = []
  for (const f of files) {
    const s = readSession(f.replace('.json', ''))
    if (!s) continue
    sessions.push({
      id: s.id,
      title: s.title,
      model_id: s.model_id,
      created_at: s.created_at,
      updated_at: s.updated_at,
      message_count: s.messages.length,
    })
  }

  return sessions.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  )
}

export function getSession(id: string): Session | null {
  return readSession(id)
}

export async function createSession(
  modelId: string,
  title = 'New Chat',
  options: { system_prompt?: string; temperature_preset?: TemperaturePreset } = {}
): Promise<Session> {
  const now = new Date().toISOString()
  const session: Session = {
    id: randomUUID(),
    title,
    model_id: modelId,
    created_at: now,
    updated_at: now,
    messages: [],
    ...(options.system_prompt ? { system_prompt: options.system_prompt } : {}),
    ...(options.temperature_preset ? { temperature_preset: options.temperature_preset } : {}),
  }
  await withSessionLock(session.id, () => saveSession(session))
  return session
}

export function deleteSession(id: string): boolean {
  let p: string
  try {
    p = sessionPath(id)
  } catch {
    return false
  }
  if (!existsSync(p)) return false
  unlinkSync(p)
  return true
}

export async function renameSession(id: string, title: string): Promise<Session | null> {
  return withSessionLock(id, async () => {
    const session = readSession(id)
    if (!session) return null
    session.title = title
    session.updated_at = new Date().toISOString()
    await saveSession(session)
    return session
  })
}

export async function updateSessionModelId(id: string, modelId: string): Promise<Session | null> {
  return withSessionLock(id, async () => {
    const session = readSession(id)
    if (!session) return null
    session.model_id = modelId
    session.updated_at = new Date().toISOString()
    await saveSession(session)
    return session
  })
}

export async function addMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  extra?: Partial<Message>
): Promise<Message | null> {
  return withSessionLock(sessionId, async () => {
    const session = readSession(sessionId)
    if (!session) return null

    const message: Message = {
      id: randomUUID(),
      role,
      content,
      timestamp: new Date().toISOString(),
      ...extra,
    }

    if (role === 'user' && session.messages.length === 0) {
      session.title = content.slice(0, 60).trim() + (content.length > 60 ? '…' : '')
    }

    session.messages.push(message)
    session.updated_at = new Date().toISOString()
    await saveSession(session)
    return message
  })
}

export async function deleteMessage(sessionId: string, index: number): Promise<boolean> {
  return withSessionLock(sessionId, async () => {
    const session = readSession(sessionId)
    if (!session) return false
    if (index < 0 || index >= session.messages.length) return false
    session.messages.splice(index, 1)
    session.updated_at = new Date().toISOString()
    await saveSession(session)
    return true
  })
}

export async function deleteLastAssistantMessage(sessionId: string): Promise<{
  deleted: boolean
  lastUserMessage: string | null
}> {
  return withSessionLock(sessionId, async () => {
    const session = readSession(sessionId)
    if (!session) return { deleted: false, lastUserMessage: null }

    let lastAiIdx = -1
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i]?.role === 'assistant') {
        lastAiIdx = i
        break
      }
    }
    if (lastAiIdx === -1) return { deleted: false, lastUserMessage: null }

    session.messages.splice(lastAiIdx, 1)

    let lastUserContent: string | null = null
    for (let i = lastAiIdx - 1; i >= 0; i--) {
      const m = session.messages[i]
      if (m?.role === 'user') {
        lastUserContent = m.content
        break
      }
    }

    session.updated_at = new Date().toISOString()
    await saveSession(session)
    return { deleted: true, lastUserMessage: lastUserContent }
  })
}

export async function appendToLastAssistantMessage(sessionId: string, content: string): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const session = readSession(sessionId)
    if (!session) return
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]
      if (m?.role === 'assistant') {
        m.content += content
        session.updated_at = new Date().toISOString()
        await saveSession(session)
        return
      }
    }
  })
}

export function searchSessions(query: string): SessionSummary[] {
  if (!query.trim()) return listSessions()
  const q = query.toLowerCase()
  const all = listSessions()
  return all.filter((s) => {
    if (s.title.toLowerCase().includes(q)) return true
    const full = getSession(s.id)
    if (!full) return false
    return full.messages.some((m) => m.content.toLowerCase().includes(q))
  })
}

export async function truncateMessagesFrom(sessionId: string, fromIndex: number): Promise<boolean> {
  return withSessionLock(sessionId, async () => {
    const session = readSession(sessionId)
    if (!session) return false
    if (fromIndex < 0 || fromIndex > session.messages.length) return false
    session.messages = session.messages.slice(0, fromIndex)
    session.updated_at = new Date().toISOString()
    await saveSession(session)
    return true
  })
}

export async function updateSessionMeta(
  sessionId: string,
  meta: { system_prompt?: string; temperature_preset?: TemperaturePreset | null }
): Promise<Session | null> {
  return withSessionLock(sessionId, async () => {
    const session = readSession(sessionId)
    if (!session) return null
    if ('system_prompt' in meta) {
      if (meta.system_prompt == null || meta.system_prompt === '') {
        delete session.system_prompt
      } else {
        session.system_prompt = meta.system_prompt
      }
    }
    if ('temperature_preset' in meta) {
      if (meta.temperature_preset == null) {
        delete session.temperature_preset
      } else {
        session.temperature_preset = meta.temperature_preset
      }
    }
    session.updated_at = new Date().toISOString()
    await saveSession(session)
    return session
  })
}

export async function importSession(data: Partial<Session>): Promise<Session> {
  const VALID_ROLES = new Set(['user', 'assistant', 'system'])
  const MAX_MESSAGES = 10_000
  const MAX_TITLE_LENGTH = 200

  // Validate messages array
  const rawMessages = data.messages
  if (rawMessages && (!Array.isArray(rawMessages) || rawMessages.length > MAX_MESSAGES)) {
    throw new Error(`Messages must be an array with at most ${MAX_MESSAGES} entries`)
  }

  const validatedMessages = (rawMessages ?? []).map((m, i) => {
    if (!m || typeof m !== 'object') {
      throw new Error(`Message at index ${i} is not an object`)
    }
    if (!VALID_ROLES.has(m.role as string)) {
      throw new Error(`Message at index ${i} has invalid role: "${String(m.role)}"`)
    }
    if (typeof m.content !== 'string') {
      throw new Error(`Message at index ${i} has non-string content`)
    }
    return {
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
      timestamp: m.timestamp ?? new Date().toISOString(),
      id: randomUUID(),
    }
  })

  const now = new Date().toISOString()
  const title = String(data.title ?? 'Imported Chat').slice(0, MAX_TITLE_LENGTH)
  const modelId = String(data.model_id ?? '')

  const session: Session = {
    id: randomUUID(),
    title,
    model_id: modelId,
    created_at: now,
    updated_at: now,
    messages: validatedMessages,
    ...(data.system_prompt ? { system_prompt: String(data.system_prompt) } : {}),
    ...(data.temperature_preset ? { temperature_preset: data.temperature_preset } : {}),
  }
  await saveSession(session)
  return session
}

export function exportSession(id: string, format: 'json' | 'markdown'): string | null {
  const session = getSession(id)
  if (!session) return null

  if (format === 'json') {
    return JSON.stringify(session, null, 2)
  }

  const lines = [
    `# ${session.title}`,
    `Exported: ${new Date().toISOString()}`,
    `Model: ${session.model_id}`,
    '',
    '---',
    '',
  ]
  for (const msg of session.messages) {
    const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1)
    const ts = msg.timestamp?.slice(0, 19) ?? ''
    lines.push(`### ${role} (${ts})`, '', msg.content, '', '---', '')
  }
  return lines.join('\n')
}
