import React, { useState, useEffect } from 'react'
import * as api from '../utils/api.js'
import { useAppStore } from '../stores/app.js'
import type { Theme } from '../../types/index.js'

export const Settings: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { theme, themes, setTheme } = useAppStore()
  const [systemPrompt, setSystemPrompt] = useState('')
  const [tempPreset, setTempPreset] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    api.getPreferences().then(prefs => {
      setSystemPrompt(prefs.default_system_prompt || '')
      setTempPreset(prefs.default_temperature_preset || '')
    })
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.savePreferences({
        default_system_prompt: systemPrompt,
        default_temperature_preset: tempPreset || null,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      // silent
    }
    setSaving(false)
  }

  const handleRestart = async () => {
    setRestarting(true)
    try {
      await api.restartServer()
      await useAppStore.getState().setStatus(null)
      await new Promise(r => setTimeout(r, 1000))
      await useAppStore.getState().fetchStatus()
    } catch {
      // silent
    }
    setRestarting(false)
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
          width: '36rem',
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
          <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>⚙️ Settings</h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--color-muted)',
            cursor: 'pointer', fontSize: '1.25rem', padding: '0.25rem',
          }}>×</button>
        </div>

        {saved && (
          <div style={{
            margin: '0.75rem 1.5rem 0',
            padding: '0.5rem 0.75rem',
            border: '1px solid #166534',
            borderRadius: '0.5rem',
            fontSize: '0.75rem',
            color: '#22c555',
          }}>
            ✓ Settings saved
          </div>
        )}

        <div style={{ padding: '1rem 1.5rem' }}>
          {/* Theme */}
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-muted)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Theme</label>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {themes.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id as Theme)}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '0.5rem',
                    border: theme === t.id ? '2px solid var(--color-accent)' : '1px solid var(--color-border)',
                    backgroundColor: theme === t.id ? 'var(--color-accent)' : 'transparent',
                    color: theme === t.id ? 'var(--color-accent-fg)' : 'var(--color-text)',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                    transition: 'all 0.15s',
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>

          {/* Temperature */}
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-muted)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Response Style</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {[
                { id: 'precise', label: '🎯 Precise' },
                { id: 'balanced', label: '⚖️ Balanced' },
                { id: 'creative', label: '💡 Creative' },
              ].map(p => (
                <button
                  key={p.id}
                  onClick={() => setTempPreset(p.id)}
                  style={{
                    padding: '0.5rem 1rem',
                    borderRadius: '0.5rem',
                    border: tempPreset === p.id ? '2px solid var(--color-accent)' : '1px solid var(--color-border)',
                    backgroundColor: tempPreset === p.id ? 'var(--color-accent)' : 'transparent',
                    color: tempPreset === p.id ? 'var(--color-accent-fg)' : 'var(--color-text)',
                    cursor: 'pointer',
                    fontSize: '0.875rem',
                    transition: 'all 0.15s',
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* System Prompt */}
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-muted)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Default system prompt for new sessions..."
              style={{
                width: '100%',
                minHeight: '8rem',
                padding: '0.75rem',
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: '0.5rem',
                color: 'var(--color-text)',
                fontSize: '0.875rem',
                fontFamily: 'JetBrains Mono, monospace',
                resize: 'vertical',
                outline: 'none',
              }}
            />
          </div>

          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '0.5rem 1.5rem',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-accent-fg)',
              border: 'none',
              borderRadius: '0.5rem',
              cursor: saving ? 'not-allowed' : 'pointer',
              fontWeight: 500,
              fontSize: '0.875rem',
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>

        {/* Restart */}
        <div style={{
          padding: '1rem 1.5rem',
          borderTop: '1px solid var(--color-border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-muted)' }}>
            Restart the server to apply changes or stop active runs.
          </span>
          <button
            onClick={handleRestart}
            disabled={restarting}
            style={{
              padding: '0.375rem 1rem',
              backgroundColor: restarting ? 'var(--color-border)' : 'transparent',
              color: restarting ? 'var(--color-muted)' : '#ef4444',
              border: '1px solid #ef4444',
              borderRadius: '0.375rem',
              cursor: restarting ? 'not-allowed' : 'pointer',
              fontSize: '0.75rem',
              transition: 'all 0.15s',
            }}
          >
            {restarting ? 'Restarting...' : '↻ Restart Server'}
          </button>
        </div>
      </div>
    </div>
  )
}
