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

/* ─── InputArea wrapper — Full featured with model controls ────────────── */
const InputAreaWrapper: React.FC = () => {
  const { activeSessionId, currentModelId, models, providers, fetchSessions, fetchModels } = useAppStore()
  const { isStreaming, cancel: cancelStream, reset: resetStream, modelType, mediaParams, setMediaParam } = useStreamStore()
  const [localInput, setLocalInput] = useState('')
  const [showModelPicker, setShowModelPicker] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachedFiles, setAttachedFiles] = useState<Array<{ name: string; path: string }>>([])

  // Image/video param controls
  const imageResolutions = ['512x512', '1024x1024', '2048x2048', '1024x768', '768x1024']
  const videoResolutions = ['512x512', '768x768', '1024x576', '1280x720', '1920x1080']
  const aspectRatios = ['1:1', '16:9', '9:16', '4:3', '3:4']
  const videoDurations = ['3s', '5s', '8s', '10s']

  const activeType = 'auto' // auto-detect from model
  const activeProvider = currentModelId?.split('/')[0] ?? ''
  const activeModel = currentModelId?.split('/')[1] ?? ''

  const groupedProviders = providers.map(p => ({
    ...p,
    models: models.filter(m => m.provider === p.id),
  }))

  const handleSend = async () => {
    if (!localInput.trim() || !activeSessionId) return
    const content = localInput.trim()
    setLocalInput('')
    setAttachedFiles([])
    if (inputRef.current) inputRef.current.style.height = 'auto'
    await startGeneration(activeSessionId, content, attachedFiles)
  }

  const handleFileSelect = () => {
    fileInputRef.current?.click()
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    const newFiles = Array.from(files).map(f => ({ name: f.name, path: f.name }))
    setAttachedFiles(prev => [...prev, ...newFiles])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeFile = (idx: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== idx))
  }

  const startGeneration = async (sessionId: string, content: string, attachments: Array<{ name: string; path: string }> = []) => {
    const lower = useAppStore.getState().currentModelId.toLowerCase()
    const isVideo = /video|mochi|wan[._-]|kling|cogvideo/i.test(lower)
    const isImage = /flux|imagen|\bimage\b|imagine|stable[._-]diff|sdxl/i.test(lower)
    const isMusic = /music|udio|suno/i.test(lower)
    const mt = isVideo ? 'video' : isImage ? 'image' : isMusic ? 'audio' : 'text'

    useStreamStore.getState().startStreaming(sessionId, mt)

    let assistantContent = ''
    let toolCalls: Array<{ tool_id: string; name: string; input: string }> = []
    let mediaItems: Array<{ url: string; media_type: 'image' | 'video'; alt?: string }> = []

    const userMsg = {
      id: `local-${Date.now()}-user`,
      role: 'user' as const,
      content,
      timestamp: new Date().toISOString(),
      attachments: attachments.length > 0 ? attachments : undefined,
    }

    window.dispatchEvent(new CustomEvent('oc-messages-update', {
      detail: { type: 'add_user', message: userMsg },
    }))

    const ctrl = new AbortController()
    try {
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, attachments }),
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
                  if (ti !== -1) toolCalls[ti]!.input = evt['input'] as string
                  break
                }
                case 'usage': break
                case 'media': {
                  const m = { url: evt['url'] as string, media_type: evt['media_type'] as 'image' | 'video', alt: evt['alt'] as string | undefined }
                  mediaItems.push(m)
                  break
                }
                case 'done': {
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

  return (
    <div style={{ maxWidth: '58rem', width: '100%', margin: '0 auto' }}>
      {/* Model selector bar */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center', padding: '0 0.25rem' }}>
        {/* Model type badge */}
        <span style={{
          padding: '0.2rem 0.6rem', borderRadius: '0.375rem', fontSize: '0.6875rem',
          fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
          backgroundColor: modelType === 'video' ? '#7c3aed22' : modelType === 'image' ? '#3b82f622' : modelType === 'audio' || modelType === 'music' ? '#f59e0b22' : 'var(--color-surface)',
          color: modelType === 'video' ? '#a78bfa' : modelType === 'image' ? '#60a5fa' : modelType === 'audio' || modelType === 'music' ? '#fbbf24' : 'var(--color-muted)',
          border: '1px solid var(--color-border)',
        }}>
          {modelType === 'video' ? '🎬 Video' : modelType === 'image' ? '🎨 Image' : modelType === 'audio' || modelType === 'music' ? '🎵 Music' : '📝 Text'}
        </span>

        {/* Current model */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowModelPicker(!showModelPicker)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              background: 'var(--color-surface)', border: '1px solid var(--color-border)',
              color: 'var(--color-text)', cursor: 'pointer', fontSize: '0.8125rem',
              fontWeight: 500, padding: '0.25rem 0.6rem', borderRadius: '0.5rem',
            }}
          >
            <span style={{ maxWidth: '16rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentModelId || 'Select model...'}
            </span>
            <span style={{ fontSize: '0.5rem', color: 'var(--color-muted)' }}>▾</span>
          </button>
          {showModelPicker && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 50 }} onClick={() => setShowModelPicker(false)} />
              <div style={{
                position: 'absolute', bottom: '120%', left: 0, zIndex: 60,
                width: '22rem', maxHeight: '28rem', overflowY: 'auto',
                backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)',
                borderRadius: '0.75rem', boxShadow: '0 25px 50px -12px rgb(0 0 0 / .25)',
                padding: '0.5rem',
              }}>
                {groupedProviders.map(p => (
                  <div key={p.id} style={{ marginBottom: '0.5rem' }}>
                    <div style={{ fontSize: '0.625rem', fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0.25rem 0.5rem' }}>
                      {p.name}
                    </div>
                    {p.models.length === 0 ? (
                      <button
                        onClick={async () => {
                          try {
                            await fetch('/api/discover-models', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ provider: p.id }),
                            })
                            await fetchModels()
                          } catch {}
                        }}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.4rem 0.5rem', background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: '0.75rem', borderRadius: '0.375rem' }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--color-bg)')}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        Discover models...
                      </button>
                    ) : (
                      p.models.map(m => (
                        <button
                          key={m.id}
                          onClick={async () => {
                            try {
                              await fetch('/api/switch-model', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ provider: m.provider, model: m.model, session_id: activeSessionId ?? undefined }),
                              })
                              await fetchModels()
                            } catch {}
                            setShowModelPicker(false)
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: '0.5rem',
                            width: '100%', textAlign: 'left', padding: '0.4rem 0.5rem',
                            background: m.id === currentModelId ? 'var(--color-bg)' : 'none',
                            border: 'none', color: m.id === currentModelId ? 'var(--color-accent)' : 'var(--color-text)',
                            cursor: 'pointer', fontSize: '0.75rem', borderRadius: '0.375rem',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = m.id === currentModelId ? 'var(--color-bg)' : 'var(--color-surface)')}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = m.id === currentModelId ? 'var(--color-bg)' : 'transparent')}
                        >
                          <span style={{ flex: 1 }}>{m.alias || m.model}</span>
                          <span style={{ fontSize: '0.5625rem', color: 'var(--color-muted)', textTransform: 'uppercase' }}>{m.type}</span>
                        </button>
                      ))
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Model-specific param shortcuts */}
        {modelType === 'image' && (
          <>
            <select
              value={mediaParams.resolution}
              onChange={(e) => setMediaParam('resolution', e.target.value)}
              style={{
                padding: '0.2rem 0.5rem', borderRadius: '0.375rem', fontSize: '0.6875rem',
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                color: 'var(--color-text)', cursor: 'pointer',
              }}
              title="Resolution"
            >
              {imageResolutions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <select
              value={mediaParams.aspectRatio}
              onChange={(e) => setMediaParam('aspectRatio', e.target.value)}
              style={{
                padding: '0.2rem 0.5rem', borderRadius: '0.375rem', fontSize: '0.6875rem',
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                color: 'var(--color-text)', cursor: 'pointer',
              }}
              title="Aspect Ratio"
            >
              {aspectRatios.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </>
        )}
        {modelType === 'video' && (
          <>
            <select
              value={mediaParams.resolution}
              onChange={(e) => setMediaParam('resolution', e.target.value)}
              style={{
                padding: '0.2rem 0.5rem', borderRadius: '0.375rem', fontSize: '0.6875rem',
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                color: 'var(--color-text)', cursor: 'pointer',
              }}
              title="Resolution"
            >
              {videoResolutions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <select
              value={mediaParams.aspectRatio}
              onChange={(e) => setMediaParam('aspectRatio', e.target.value)}
              style={{
                padding: '0.2rem 0.5rem', borderRadius: '0.375rem', fontSize: '0.6875rem',
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                color: 'var(--color-text)', cursor: 'pointer',
              }}
              title="Aspect Ratio"
            >
              {aspectRatios.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <select
              value={mediaParams.videoDuration}
              onChange={(e) => setMediaParam('videoDuration', e.target.value)}
              style={{
                padding: '0.2rem 0.5rem', borderRadius: '0.375rem', fontSize: '0.6875rem',
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                color: 'var(--color-text)', cursor: 'pointer',
              }}
              title="Duration"
            >
              {videoDurations.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </>
        )}
      </div>

      {/* Text input area */}
      <div style={{
        position: 'relative', width: '100%',
        border: '1px solid var(--color-border)',
        borderRadius: '0.75rem', overflow: 'hidden',
        backgroundColor: 'var(--color-surface)',
      }}>
        {/* Attached files */}
        {attachedFiles.length > 0 && (
          <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', padding: '0.5rem 3rem 0.25rem 3rem' }}>
            {attachedFiles.map((f, i) => (
              <span key={i} style={{
                display: 'flex', alignItems: 'center', gap: '0.375rem',
                padding: '0.2rem 0.5rem', borderRadius: '0.375rem',
                background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                fontSize: '0.6875rem', color: 'var(--color-muted)',
              }}>
                📎 {f.name}
                <span
                  onClick={() => removeFile(i)}
                  style={{ cursor: 'pointer', color: 'var(--color-muted)', fontWeight: 700, marginLeft: '0.25rem' }}
                >×</span>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={inputRef}
          value={localInput}
          onChange={(e) => { setLocalInput(e.target.value); if (inputRef.current) inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 400)}px` }}
          onKeyDown={handleKeyDown}
          placeholder={modelType === 'image' ? 'Describe an image to generate...' : modelType === 'video' ? 'Describe a video to generate...' : modelType === 'audio' || modelType === 'music' ? 'Describe audio to generate...' : 'Message OpenClaude... (⌘+Enter to send)'}
          disabled={isStreaming}
          style={{
            width: '100%', padding: '0.75rem 3.5rem 3.5rem 3.5rem',
            background: 'transparent', border: 'none',
            color: isStreaming ? 'var(--color-muted)' : 'var(--color-text)',
            fontFamily: 'Inter, sans-serif', fontSize: '0.875rem', lineHeight: 1.5,
            resize: 'none', outline: 'none',
            minHeight: '88px', maxHeight: '20rem',
          }}
          rows={3}
          className="placeholder-muted"
        />

        {/* Bottom toolbar inside the input area */}
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.375rem 0.5rem', gap: '0.5rem',
        }}>
          {/* Left side: Paperclip + regenerate */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} multiple onChange={onFileChange} />
            <button
              onClick={handleFileSelect}
              disabled={isStreaming}
              style={{
                width: '1.75rem', height: '1.75rem',
                borderRadius: '0.375rem', border: 'none',
                background: 'none', color: 'var(--color-muted)',
                cursor: isStreaming ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '1rem',
              }}
              title="Attach file"
            >
              📎
            </button>
            {!isStreaming && (
              <button
                onClick={handleRegenerate}
                style={{
                  width: '1.75rem', height: '1.75rem',
                  borderRadius: '0.375rem', border: 'none',
                  background: 'none', color: 'var(--color-muted)',
                  cursor: 'pointer', fontSize: '0.875rem',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                title="Regenerate"
              >
                ↻
              </button>
            )}
          </div>

          {/* Right side: Cancel / Send */}
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {isStreaming ? (
              <button onClick={handleCancel} style={{
                backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)',
                color: 'var(--color-text)', cursor: 'pointer', fontSize: '0.8125rem',
                padding: '0.375rem 0.75rem', borderRadius: '0.5rem',
                display: 'flex', alignItems: 'center', gap: '0.375rem',
              }}>
                ■ Stop
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!localInput.trim()}
                style={{
                  backgroundColor: localInput.trim() ? 'var(--color-accent)' : 'var(--color-border)',
                  color: localInput.trim() ? 'var(--color-accent-fg)' : 'var(--color-muted)',
                  border: 'none', cursor: localInput.trim() ? 'pointer' : 'not-allowed',
                  fontSize: '0.8125rem', padding: '0.375rem 0.75rem',
                  borderRadius: '0.5rem', fontWeight: 500,
                  display: 'flex', alignItems: 'center', gap: '0.375rem',
                  transition: 'all 0.15s',
                }}
              >
                Send ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
