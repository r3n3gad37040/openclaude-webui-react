import React, { useState, useRef, useEffect, type MouseEvent, type KeyboardEvent } from 'react'
import { useAppStore } from './stores/app.js'
import { useStreamStore } from './stores/streaming.js'
import { Sidebar } from './components/Sidebar.js'
import { Chat } from './components/Chat.js'
import { TelemetryBar } from './components/TelemetryBar.js'
import { KeyManager } from './components/KeyManager.js'
import { Settings } from './components/Settings.js'

export default function App() {
  const { init, loading, createSession, fetchModels, activeSessionId } = useAppStore()
  const { isStreaming, cancel: cancelStream } = useStreamStore()
  const [showKeys, setShowKeys] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  const handleSend = async (message: string) => {
    const session = useAppStore.getState()
    if (!session.activeSessionId) {
      await session.createSession()
    }
    // Chat component handles the actual SSE send
    // We just need to trigger it via a custom event since the send logic is in Chat
    window.dispatchEvent(new CustomEvent('oc-send', { detail: message }))
  }

  const handleReloadModels = () => {
    void fetchModels()
  }

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--color-bg)', color: 'var(--color-muted)' }}>
        <div style={{ textAlign: 'center' }}>
          <span className="animate-spin" style={{ display: 'inline-block', fontSize: '2rem' }}>⚙</span>
          <p style={{ marginTop: '1rem', fontSize: '0.875rem' }}>Loading OpenClaude...</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--color-bg)' }}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Sidebar */}
        <Sidebar
          onToggleKeys={() => setShowKeys(true)}
          onToggleSettings={() => setShowSettings(true)}
        />

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Telemetry bar */}
          <TelemetryBar />

          {/* Chat area */}
          <Chat />

          {/* Input area (outside Chat so it can control the layout) */}
          <div style={{ padding: '0.75rem 1.5rem' }}>
            <InputAreaWrapper />
          </div>
        </div>
      </div>

      {/* Modals */}
      {showKeys && <KeyManager onClose={() => setShowKeys(false)} />}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  )
}

/* ─── InputArea wrapper ──────────────────────────────────────────────── */
/* Listens to oc-send events from header and passes messages down */
const InputAreaWrapper: React.FC = () => {
  const { activeSessionId, currentModelId, models, fetchSessions, fetchModels } = useAppStore()
  const { isStreaming, cancel: cancelStream, reset: resetStream } = useStreamStore()
  const [localInput, setLocalInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = async () => {
    if (!localInput.trim() || !activeSessionId) return
    const content = localInput.trim()
    setLocalInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto'

    await startGeneration(activeSessionId, content)
  }

  const startGeneration = async (sessionId: string, content: string) => {
    const { models: allModels } = useAppStore.getState()
    const modelEntry = allModels.find(m => m.id === useAppStore.getState().currentModelId)
    const lower = useAppStore.getState().currentModelId.toLowerCase()
    const isVideo = /video|mochi|wan[._-]|kling|cogvideo/i.test(lower)
    const isImage = /flux|imagen|\bimage\b|imagine|stable[._-]diff|sdxl/i.test(lower)
    const modelType = isVideo ? 'video' : isImage ? 'image' : 'text'

    useStreamStore.getState().startStreaming(sessionId, modelType)

    // For media models, bypass the CLI and send via SSE directly
    // (same URL as text, the backend routes based on model type)
    let assistantContent = ''
    let toolCalls: Array<{ tool_id: string; name: string; input: string }> = []
    let mediaItems: Array<{ url: string; media_type: 'image' | 'video'; alt?: string }> = []
    let usage: { input_tokens: number; output_tokens: number } | null = null

    const userMsg = {
      id: `local-${Date.now()}-user`,
      role: 'user' as const,
      content,
      timestamp: new Date().toISOString(),
    }

    // Add to local state via event
    window.dispatchEvent(new CustomEvent('oc-messages-update', {
      detail: { type: 'add_user', message: userMsg },
    }))

    // Send request
    const ctrl = new AbortController()
    try {
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content }),
        signal: ctrl.signal,
      }).then(async (res) => {
        if (!res.ok) {
          window.dispatchEvent(new CustomEvent('oc-messages-update', {
            detail: { type: 'error', error: `Server ${res.status}` },
          }))
          return
        }

        const reader = res.body?.getReader()
        if (!reader) return

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6)
            if (!raw || raw === '[DONE]') continue

            try {
              const evt = JSON.parse(raw) as Record<string, unknown>
              switch (evt['type']) {
                case 'chunk': {
                  assistantContent += evt['content'] as string
                  window.dispatchEvent(new CustomEvent('oc-messages-update', {
                    detail: { type: 'stream', id: 'streaming', content: assistantContent },
                  }))
                  break
                }
                case 'tool_start':
                  toolCalls.push({ tool_id: evt['tool_id'] as string, name: evt['name'] as string, input: '' })
                  break
                case 'tool_done': {
                  const ti = toolCalls.findIndex(t => t.tool_id === evt['tool_id'])
                  if (ti !== -1) toolCalls[ti].input = evt['input'] as string
                  break
                }
                case 'usage': {
                  const d = evt['data'] as { input_tokens: number; output_tokens: number }
                  usage = d
                  break
                }
                case 'media': {
                  const m = {
                    url: evt['url'] as string,
                    media_type: evt['media_type'] as 'image' | 'video',
                    alt: evt['alt'] as string | undefined,
                  }
                  mediaItems.push(m)
                  break
                }
                case 'done': {
                  // Refetch from server
                  window.dispatchEvent(new CustomEvent('oc-messages-update', {
                    detail: { type: 'reload', sessionId },
                  }))
                  void fetchSessions()
                  void fetchModels()
                  break
                }
                case 'error':
                  window.dispatchEvent(new CustomEvent('oc-messages-update', {
                    detail: { type: 'error', error: evt['content'] },
                  }))
                  break
              }
            } catch { /* skip keepalives */ }
          }
        }
      })
    } catch (err) {
      if (!ctrl.signal.aborted) {
        window.dispatchEvent(new CustomEvent('oc-messages-update', {
          detail: { type: 'error', error: err instanceof Error ? err.message : 'Stream failed' },
        }))
      }
    }
    useStreamStore.getState().reset()
  }

  const handleCancel = async () => {
    if (activeSessionId) {
      await fetch(`/api/sessions/${activeSessionId}/cancel`, { method: 'POST' })
    }
    cancelStream()
    resetStream()
  }

  const handleRegenerate = async () => {
    if (!activeSessionId) return
    await fetch(`/api/messages/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: activeSessionId }),
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  const autoResize = () => {
    if (!inputRef.current) return
    inputRef.current.style.height = 'auto'
    inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 400)}px`
  }

  return (
    <div style={{
      maxWidth: '48rem',
      width: '100%',
      margin: '0 auto',
      border: '1px solid var(--color-border)',
      borderRadius: '0.75rem',
      overflow: 'hidden',
      backgroundColor: 'var(--color-surface)',
    }}>
      <textarea
        ref={inputRef}
        value={localInput}
        onChange={(e) => { setLocalInput(e.target.value); autoResize() }}
        onKeyDown={handleKeyDown}
        placeholder="Message OpenClaude... (⌘+Enter to send)"
        disabled={isStreaming}
        style={{
          width: '100%',
          padding: '0.75rem 3rem 0.75rem 1rem',
          background: 'transparent',
          border: 'none',
          color: isStreaming ? 'var(--color-muted)' : 'var(--color-text)',
          fontFamily: 'Inter, sans-serif',
          fontSize: '0.875rem',
          lineHeight: 1.5,
          resize: 'none',
          outline: 'none',
          minHeight: '44px',
          maxHeight: '20rem',
        }}
        rows={1}
        className="placeholder-muted"
      />
      <div style={{ position: 'absolute', right: '0.5rem', bottom: '0.5rem', display: 'flex', gap: '0.25rem' }}>
        {!isStreaming && (
          <button onClick={handleRegenerate} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--color-muted)', fontSize: '1rem', padding: '0.25rem 0.5rem',
          }} title="Regenerate">↻</button>
        )}
        {isStreaming ? (
          <button onClick={handleCancel} style={{
            width: '2rem', height: '2rem', borderRadius: '9999px',
            border: '1px solid var(--color-border)', backgroundColor: 'var(--color-bg)',
            color: 'var(--color-text)', cursor: 'pointer', fontSize: '0.75rem',
          }}>■</button>
        ) : (
          <button onClick={handleSend} disabled={!localInput.trim()} style={{
            width: '2rem', height: '2rem', borderRadius: '9999px',
            border: 'none',
            backgroundColor: localInput.trim() ? 'var(--color-accent)' : 'var(--color-border)',
            color: localInput.trim() ? 'var(--color-accent-fg)' : 'var(--color-muted)',
            cursor: localInput.trim() ? 'pointer' : 'not-allowed',
            fontSize: '0.75rem',
            transition: 'all 0.15s',
          }}>↑</button>
        )}
      </div>
    </div>
  )
}
