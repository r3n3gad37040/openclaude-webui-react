import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/app.js'
import { useStreamStore } from '../stores/streaming.js'
import { useSSE } from '../hooks/useSSE.js'
import { MessageBubble } from './MessageBubble.js'
import type { Message, GeneratedMedia } from '../../types/index.js'
import * as api from '../utils/api.js'

const STATUS_COLORS: Record<string, string> = {
  green: '#22c555',
  red: '#ef4444',
}

export const Chat: React.FC = () => {
  const { activeSessionId, sessions, currentModelId, currentModel } = useAppStore()
  const { isStreaming, modelType } = useStreamStore()
  const { connect, cancel } = useSSE()
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [showModel, setShowModel] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef(false)
  const pendingMediaRef = useRef<{ url: string; media_type: 'image' | 'video'; alt?: string }[]>([])

  // Fetch messages when session changes
  useEffect(() => {
    if (!activeSessionId) { setMessages([]); return }
    abortRef.current = true
    const fetchMsgs = async () => {
      try {
        const session = await api.getSession(activeSessionId)
        setMessages(session.messages ?? [])
      } catch { setMessages([]) }
    }
    fetchMsgs()
    return () => { abortRef.current = false }
  }, [activeSessionId])

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = useCallback(async (content: string) => {
    if (!activeSessionId || !currentModelId) return

    // Add user message immediately
    const userMsg: Message = {
      id: `local-${Date.now()}-user`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])

    // Start streaming
    await api.sendMessage(activeSessionId, content)

    // Create assistant placeholder and stream into it
    const assistantId = `local-${Date.now()}-assistant`
    let assistantContent = ''
    pendingMediaRef.current = []

    setMessages(prev => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      generated_media: [],
      tool_calls: [],
    }])

    // SSE connection
    let aborted = false
    const controller = new AbortController()

    connect(activeSessionId, currentModelId, content, {
      onChunk: (chunk) => {
        assistantContent += chunk
        setMessages(prev => {
          const next = [...prev]
          const idx = next.findIndex(m => m.id === assistantId)
          if (idx !== -1) {
            next[idx] = { ...next[idx], content: assistantContent }
          }
          return next
        })
      },
      onToolStart: (name, _id) => {
        setMessages(prev => {
          const next = [...prev]
          const idx = next.findIndex(m => m.id === assistantId)
          if (idx !== -1) {
            next[idx] = {
              ...next[idx],
              tool_calls: [...(next[idx].tool_calls ?? []), { tool_id: _id, name, input: '' }],
            }
          }
          return next
        })
      },
      onToolDone: (_name, _id, input) => {
        setMessages(prev => {
          const next = [...prev]
          const idx = next.findIndex(m => m.id === assistantId)
          if (idx !== -1) {
            const tcs = next[idx].tool_calls ?? []
            const ti = tcs.findIndex(t => t.tool_id === _id)
            if (ti !== -1) tcs[ti] = { ...tcs[ti], input }
          }
          return next
        })
      },
      onUsage: (input_tokens, output_tokens) => {
        setMessages(prev => {
          const next = [...prev]
          const idx = next.findIndex(m => m.id === assistantId)
          if (idx !== -1) {
            const costModel = { input_per_m: 3.0, output_per_m: 15.0 } // default Claude rates
            const cost = parseFloat(((input_tokens * costModel.input_per_m) / 1_000_000 + (output_tokens * costModel.output_per_m) / 1_000_000).toFixed(6))
            next[idx] = { ...next[idx], input_tokens, output_tokens, estimated_cost: cost }
          }
          return next
        })
      },
      onMedia: (url, media_type, alt) => {
        pendingMediaRef.current.push({ url, media_type, alt })
        setMessages(prev => {
          const next = [...prev]
          const idx = next.findIndex(m => m.id === assistantId)
          if (idx !== -1) {
            next[idx] = {
              ...next[idx],
              generated_media: [...(next[idx].generated_media ?? []), { url, media_type, alt }],
            }
          }
          return next
        })
      },
      onDone: () => {
        if (!aborted) {
          void useAppStore.getState().fetchStatus()
          void useAppStore.getState().fetchSessions() // refresh session list (title may have updated)
          // Refetch from server to get persisted state
          api.getSession(activeSessionId).then(s => {
            setMessages(s.messages ?? [])
          })
        }
      },
      onError: (err) => {
        if (!aborted) {
          setMessages(prev => {
            const next = [...prev]
            const idx = next.findIndex(m => m.id === assistantId)
            if (idx !== -1) {
              next[idx] = { ...next[idx], content: next[idx].content + `\n\n⚠️ Error: ${err}` }
            }
            return next
          })
        }
      },
    }, controller.signal)
  }, [activeSessionId, currentModelId, connect])

  const handleCancel = useCallback(async () => {
    if (activeSessionId) {
      await api.cancelMessage(activeSessionId)
    }
  }, [activeSessionId])

  const handleRegenerate = useCallback(async () => {
    if (!activeSessionId) return
    await api.regenerateResponse(activeSessionId)
    const s = await api.getSession(activeSessionId)
    setMessages(s.messages ?? [])
  }, [activeSessionId])

  if (!activeSessionId) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--color-muted)' }}>
          <p style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Select a conversation</p>
          <p style={{ fontSize: '0.875rem' }}>or start a new one from the sidebar</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {/* Header with model selector */}
      <div style={{
        padding: '0.75rem 1.5rem',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'relative',
      }}>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowModel(!showModel)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              background: 'none',
              border: 'none',
              color: 'var(--color-text)',
              cursor: 'pointer',
              fontSize: '0.9375rem',
              fontWeight: 500,
              padding: '0.375rem 0.75rem',
              borderRadius: '0.375rem',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-surface)' }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent' }}
          >
            {currentModel || 'Select model'}
            <span style={{ fontSize: '0.625rem', color: 'var(--color-muted)' }}>▾</span>
          </button>

          {/* Model dropdown */}
          {showModel && (
            <ModelDropdown onClose={() => setShowModel(false)} sessionId={activeSessionId} />
          )}
        </div>

        {/* Provider key status indicators */}
        <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
          <ProviderStatusDots />
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.5rem 0' }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--color-muted)', paddingTop: '15vh' }}>
            <p style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
              {modelType === 'image' ? '🎨' : modelType === 'video' ? '🎬' : '🤖'}
            </p>
            <p style={{ fontSize: '1rem' }}>
              {modelType === 'image' ? 'Describe an image to generate' : modelType === 'video' ? 'Describe a video to generate' : 'Start a conversation'}
            </p>
            {currentModel && (
              <p style={{ marginTop: '0.5rem', fontSize: '0.75rem' }}>{currentModelId}</p>
            )}
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} isLatest={false} />
          ))
        )}
      </div>
    </div>
  )
}

/* ─── Model Dropdown ─────────────────────────────────────────────────── */
const ModelDropdown: React.FC<{ onClose: () => void; sessionId: string }> = ({ onClose, sessionId }) => {
  const { models, currentModelId, providers, fetchModels } = useAppStore()
  const [selecting, setSelecting] = useState(false)

  const handleSwitch = async (provider: string, model: string) => {
    setSelecting(true)
    try {
      await api.switchModel(provider, model, undefined, false, sessionId)
      await useAppStore.getState().fetchModels()
      await useAppStore.getState().fetchStatus()
      onClose()
    } catch (err) {
      console.error(err)
    }
    setSelecting(false)
  }

  const handleDiscover = async (provider: string) => {
    setSelecting(true)
    try {
      await api.discoverModels(provider)
      await fetchModels()
    } catch (err) {
      console.error(err)
    }
    setSelecting(false)
  }

  const grouped = providers.map(p => ({
    ...p,
    models: models.filter(m => m.provider === p.id),
  }))

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 50 }} onClick={onClose} />
      <div style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        zIndex: 60,
        width: '20rem',
        maxHeight: '30rem',
        overflowY: 'auto',
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: '0.75rem',
        boxShadow: '0 25px 50px -12px rgb(0 0 0 / .25)',
        padding: '0.5rem',
        animation: 'slideUp 0.2s ease-out',
      }}>
        {grouped.map(p => (
          <div key={p.id} style={{ marginBottom: '0.5rem' }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0.25rem 0.75rem',
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--color-muted)',
              textTransform: 'uppercase',
            }}>
              <span>{p.name}</span>
              {p.models.length === 0 && !selecting && (
                <button
                  onClick={() => handleDiscover(p.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--color-accent)',
                    cursor: 'pointer',
                    fontSize: '0.625rem',
                    padding: '0.125rem 0.375rem',
                  }}
                >
                  Discover
                </button>
              )}
            </div>
            {p.models.map(m => (
              <button
                key={m.id}
                onClick={() => handleSwitch(m.provider, m.model)}
                disabled={selecting}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '0.375rem 0.75rem',
                  backgroundColor: m.id === currentModelId ? 'var(--color-accent)' : 'transparent',
                  color: m.id === currentModelId ? 'var(--color-accent-fg)' : 'var(--color-text)',
                  border: 'none',
                  borderRadius: '0.375rem',
                  cursor: selecting ? 'not-allowed' : 'pointer',
                  textAlign: 'left',
                  fontSize: '0.875rem',
                  transition: 'background-color 0.15s',
                }}
              >
                {m.alias}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

/* ─── Provider Status Dots ───────────────────────────────────────────── */
const ProviderStatusDots: React.FC = () => {
  const { status } = useAppStore()
  if (!status?.providers) return null
  return (
    <>{status.providers.slice(0, 8).map(p => (
      <div
        key={p.id}
        title={`${p.name}: ${p.key_status}`}
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '9999px',
          backgroundColor: STATUS_COLORS[p.key_status] ?? '#6b7280',
        }}
      />
    ))}</>
  )
}
