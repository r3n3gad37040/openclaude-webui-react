import React, { useState } from 'react'
import * as api from '../utils/api.js'
import { useAppStore } from '../stores/app.js'

interface KeyManagerProps {
  onClose: () => void
}

const ALL_PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI', envKey: 'OPENAI_API_KEY' },
  { id: 'gemini', name: 'Google (Gemini)', envKey: 'GEMINI_API_KEY' },
  { id: 'mistral', name: 'Mistral', envKey: 'MISTRAL_API_KEY' },
  { id: 'moonshot', name: 'Moonshot', envKey: 'MOONSHOT_API_KEY' },
  { id: 'nous', name: 'Nous Research', envKey: 'NOUS_API_KEY' },
  { id: 'venice', name: 'Venice.ai', envKey: 'VENICE_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY' },
  { id: 'xai', name: 'xAI (Grok)', envKey: 'XAI_API_KEY' },
  { id: 'groq', name: 'Groq', envKey: 'GROQ_API_KEY' },
  { id: 'dolphin', name: 'Dolphin', envKey: 'DOLPHIN_API_KEY' },
  { id: 'nineteen', name: 'Nineteen', envKey: 'NINETEEN_API_KEY' },
]

const TOOL_PROVIDERS = [
  { id: 'apify', name: 'Apify', envKey: 'APIFY_TOKEN' },
  { id: 'firecrawl', name: 'Firecrawl', envKey: 'FIRECRAWL_API_KEY' },
]

export const KeyManager: React.FC<KeyManagerProps> = ({ onClose }) => {
  const { providers: _providers } = useAppStore()
  const [keys, setKeys] = useState<Record<string, { has_key: boolean; last4: string }> | null>(null)
  const [editingProvider, setEditingProvider] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const loadKeys = async () => {
    try {
      const { keys: k } = await api.getProviderKeys()
      setKeys(k)
    } catch { setKeys({}) }
  }

  React.useEffect(() => { void loadKeys() }, [])

  const handleSave = async (provider: string) => {
    setSaving(true)
    try {
      await api.setProviderKey(provider, editingKey)
      await loadKeys()
      setEditingProvider(null)
      setEditingKey('')
      setSaved(provider)
      setTimeout(() => setSaved(null), 3000)
    } catch (err) {
      console.error(err)
    }
    setSaving(false)
  }

  const handleDelete = async (provider: string) => {
    if (confirmDelete !== provider) {
      setConfirmDelete(provider)
      setTimeout(() => setConfirmDelete(null), 3000)
      return
    }
    try {
      await api.deleteProviderKey(provider)
      setConfirmDelete(null)
      await loadKeys()
      await useAppStore.getState().fetchModels()
    } catch {
      setConfirmDelete(null)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      backgroundColor: '#00000080',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fadeIn 0.15s ease-out',
    }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '32rem',
          maxWidth: '90vw',
          maxHeight: '80vh',
          overflowY: 'auto',
          backgroundColor: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: '1rem',
          boxShadow: '0 25px 50px -12px rgb(0 0 0 / .25)',
          animation: 'slideUp 0.2s ease-out',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '1rem 1.5rem',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>🔑 API Keys</h2>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: 'var(--color-muted)',
              cursor: 'pointer', fontSize: '1.25rem', padding: '0.25rem',
            }}
          >×</button>
        </div>

        {saved && (
          <div style={{
            margin: '0.75rem 1.5rem 0',
            padding: '0.5rem 0.75rem',
            backgroundColor: 'var(--color-green-900/20)',
            border: '1px solid #166534',
            borderRadius: '0.5rem',
            fontSize: '0.75rem',
            color: '#22c555',
          }}>
            ✓ Key saved for {ALL_PROVIDERS.find(p => p.id === saved)?.name}
          </div>
        )}

        {/* AI Providers */}
        <div style={{ padding: '1rem 1.5rem' }}>
          <h3 style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-muted)', marginBottom: '0.75rem', textTransform: 'uppercase' }}>AI Providers</h3>
          {ALL_PROVIDERS.map(p => {
            const k = keys?.[p.id]
            const hasKey = k?.has_key ?? false
            const last4 = k?.last4 ?? ''
            return (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.5rem 0',
                borderBottom: '1px solid var(--color-border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{
                    width: '8px', height: '8px', borderRadius: '9999px',
                    backgroundColor: hasKey ? '#22c555' : '#ef4444',
                  }} />
                  <span style={{ fontSize: '0.875rem' }}>{p.name}</span>
                  {hasKey && <span style={{ fontSize: '0.625rem', color: 'var(--color-muted)', fontFamily: 'monospace' }}>••••{last4}</span>}
                </div>
                <div style={{ display: 'flex', gap: '0.375rem' }}>
                  {editingProvider === p.id ? (
                    <div style={{ display: 'flex', gap: '0.375rem' }}>
                      <input
                        autoFocus
                        type="password"
                        value={editingKey}
                        onChange={(e) => setEditingKey(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(p.id); if (e.key === 'Escape') setEditingProvider(null) }}
                        placeholder="sk-..."
                        style={{
                          width: '12rem',
                          padding: '0.25rem 0.5rem',
                          background: 'var(--color-bg)',
                          border: '1px solid var(--color-accent)',
                          borderRadius: '0.375rem',
                          color: 'var(--color-text)',
                          fontSize: '0.75rem',
                          fontFamily: 'monospace',
                          outline: 'none',
                        }}
                      />
                      <button
                        onClick={() => { if (editingKey) handleSave(p.id) }}
                        disabled={!editingKey || saving}
                        style={{
                          padding: '0.25rem 0.5rem',
                          backgroundColor: editingKey ? 'var(--color-accent)' : 'var(--color-border)',
                          color: editingKey ? 'var(--color-accent-fg)' : 'var(--color-muted)',
                          border: 'none', borderRadius: '0.25rem',
                          fontSize: '0.75rem', cursor: editingKey ? 'pointer' : 'not-allowed',
                        }}
                      >Save</button>
                      <button
                        onClick={() => { setEditingProvider(null); setEditingKey('') }}
                        style={{
                          padding: '0.25rem 0.5rem',
                          background: 'none', border: '1px solid var(--color-border)',
                          borderRadius: '0.25rem', color: 'var(--color-muted)',
                          cursor: 'pointer', fontSize: '0.75rem',
                        }}
                      >×</button>
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => { setEditingProvider(p.id); setEditingKey('') }}
                        style={{
                          padding: '0.25rem 0.5rem',
                          background: 'none', border: '1px solid var(--color-border)',
                          borderRadius: '0.375rem', cursor: 'pointer',
                          fontSize: '0.625rem', color: hasKey ? 'var(--color-muted)' : 'var(--color-accent)',
                        }}
                      >{hasKey ? 'Edit' : 'Set'}</button>
                      {hasKey && (
                        <button
                          onClick={() => handleDelete(p.id)}
                          style={{
                            padding: '0.25rem 0.5rem',
                            background: 'none',
                            border: confirmDelete === p.id ? '1px solid #ef4444' : '1px solid var(--color-border)',
                            borderRadius: '0.375rem', cursor: 'pointer',
                            fontSize: '0.625rem',
                            color: confirmDelete === p.id ? '#ef4444' : 'var(--color-muted)',
                          }}
                        >{confirmDelete === p.id ? 'Confirm' : 'Delete'}</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Tool Providers */}
        <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--color-border)' }}>
          <h3 style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-muted)', marginBottom: '0.75rem', textTransform: 'uppercase' }}>Tool Providers</h3>
          {TOOL_PROVIDERS.map(p => {
            const k = keys?.[p.id]
            const hasKey = k?.has_key ?? false
            const last4 = k?.last4 ?? ''
            return (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.5rem 0',
                borderBottom: '1px solid var(--color-border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{
                    width: '8px', height: '8px', borderRadius: '9999px',
                    backgroundColor: hasKey ? '#22c555' : '#ef4444',
                  }} />
                  <span style={{ fontSize: '0.875rem' }}>{p.name}</span>
                  {hasKey && <span style={{ fontSize: '0.625rem', color: 'var(--color-muted)', fontFamily: 'monospace' }}>••••{last4}</span>}
                </div>
                <div style={{ display: 'flex', gap: '0.375rem' }}>
                  {editingProvider === p.id ? (
                    <div style={{ display: 'flex', gap: '0.375rem' }}>
                      <input
                        autoFocus
                        type="password"
                        value={editingKey}
                        onChange={(e) => setEditingKey(e.target.value)}
                        placeholder="token..."
                        style={{
                          width: '12rem',
                          padding: '0.25rem 0.5rem',
                          background: 'var(--color-bg)',
                          border: '1px solid var(--color-accent)',
                          borderRadius: '0.375rem',
                          color: 'var(--color-text)',
                          fontSize: '0.75rem',
                          fontFamily: 'monospace',
                          outline: 'none',
                        }}
                      />
                      <button onClick={() => { if (editingKey) handleSave(p.id) }} style={{
                        padding: '0.25rem 0.5rem',
                        backgroundColor: editingKey ? 'var(--color-accent)' : 'var(--color-border)',
                        color: editingKey ? 'var(--color-accent-fg)' : 'var(--color-muted)',
                        border: 'none', borderRadius: '0.25rem',
                        fontSize: '0.75rem', cursor: editingKey ? 'pointer' : 'not-allowed',
                      }}>Save</button>
                    </div>
                  ) : (
                    <>
                      <button onClick={() => { setEditingProvider(p.id); setEditingKey('') }} style={{
                        padding: '0.25rem 0.5rem',
                        background: 'none', border: '1px solid var(--color-border)',
                        borderRadius: '0.375rem', cursor: 'pointer',
                        fontSize: '0.625rem', color: hasKey ? 'var(--color-muted)' : 'var(--color-accent)',
                      }}>{hasKey ? 'Edit' : 'Set'}</button>
                      {hasKey && (
                        <button onClick={() => handleDelete(p.id)} style={{
                          padding: '0.25rem 0.5rem',
                          background: 'none',
                          border: confirmDelete === p.id ? '1px solid #ef4444' : '1px solid var(--color-border)',
                          borderRadius: '0.375rem', cursor: 'pointer',
                          fontSize: '0.625rem',
                          color: confirmDelete === p.id ? '#ef4444' : 'var(--color-muted)',
                        }}>{confirmDelete === p.id ? 'Confirm' : 'Delete'}</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
