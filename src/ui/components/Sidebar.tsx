import React, { useState } from 'react'
import { useAppStore } from '../stores/app.js'

export const Sidebar: React.FC<{ onToggleKeys: () => void; onToggleSettings: () => void }> = ({ onToggleKeys, onToggleSettings }) => {
  const { sessions, activeSessionId, selectSession, createSession, deleteSession, renameSession } = useAppStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const handleNew = async () => {
    await createSession()
  }

  const handleDoubleClick = (s: { id: string; title: string }) => {
    setEditingId(s.id)
    setEditTitle(s.title)
  }

  const handleRenameDone = async () => {
    if (editingId && editTitle.trim()) {
      await renameSession(editingId, editTitle.trim())
    }
    setEditingId(null)
  }

  const handleDelete = async (id: string) => {
    if (confirmDelete === id) {
      await deleteSession(id)
      setConfirmDelete(null)
    } else {
      setConfirmDelete(id)
      setTimeout(() => setConfirmDelete(null), 3000)
    }
  }

  return (
    <div style={{
      width: '16rem',
      minWidth: '16rem',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      borderRight: '1px solid var(--color-border)',
      backgroundColor: 'var(--color-surface)',
    }}>
      {/* Header */}
      <div style={{ padding: '1rem', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600, letterSpacing: '-0.025em', margin: 0 }}>
            🤖 OpenClaude
          </h1>
        </div>
        <button
          onClick={handleNew}
          style={{
            width: '100%',
            padding: '0.5rem',
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-accent-fg)',
            border: 'none',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontWeight: 500,
            fontSize: '0.875rem',
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.9')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
        >
          + New Chat
        </button>
      </div>

      {/* Session List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0.25rem' }}>
        {sessions.map((s) => (
          <div
            key={s.id}
            onDoubleClick={() => handleDoubleClick(s)}
            style={{
              padding: '0.5rem 0.75rem',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              backgroundColor: s.id === activeSessionId ? 'var(--color-user-bubble)' : 'transparent',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              transition: 'background-color 0.15s',
              marginBottom: '0.25rem',
            }}
            onMouseEnter={(e) => {
              if (s.id !== activeSessionId) e.currentTarget.style.backgroundColor = 'var(--color-border)'
            }}
            onMouseLeave={(e) => {
              if (s.id !== activeSessionId) e.currentTarget.style.backgroundColor = 'transparent'
            }}
            onClick={() => selectSession(s.id)}
          >
            {editingId === s.id ? (
              <input
                autoFocus
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onBlur={handleRenameDone}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRenameDone(); if (e.key === 'Escape') setEditingId(null) }}
                style={{
                  flex: 1,
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-accent)',
                  borderRadius: '0.25rem',
                  padding: '0.25rem',
                  color: 'var(--color-text)',
                  fontSize: '0.875rem',
                  outline: 'none',
                }}
              />
            ) : (
              <span style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: '0.875rem',
                fontWeight: s.id === activeSessionId ? 500 : 400,
              }}>
                {s.title || 'New Chat'}
              </span>
            )}
            {editingId !== s.id && (
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(s.id) }}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: confirmDelete === s.id ? '#f87171' : 'var(--color-muted)',
                  fontSize: '0.75rem',
                  padding: '0.125rem 0.375rem',
                  opacity: s.id === activeSessionId ? 1 : 0,
                  transition: 'opacity 0.15s, color 0.15s',
                }}
                title={confirmDelete === s.id ? 'Click again to confirm' : 'Delete'}
              >
                {confirmDelete === s.id ? '✓' : '×'}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{
        padding: '0.5rem 1rem',
        borderTop: '1px solid var(--color-border)',
        display: 'flex',
        gap: '0.5rem',
      }}>
        <button
          onClick={onToggleKeys}
          style={{
            flex: 1,
            padding: '0.375rem',
            backgroundColor: 'transparent',
            border: '1px solid var(--color-border)',
            borderRadius: '0.375rem',
            color: 'var(--color-muted)',
            cursor: 'pointer',
            fontSize: '0.75rem',
            transition: 'border-color 0.15s, color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-accent)'
            e.currentTarget.style.color = 'var(--color-accent)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-border)'
            e.currentTarget.style.color = 'var(--color-muted)'
          }}
        >
          🔑 Keys
        </button>
        <button
          onClick={onToggleSettings}
          style={{
            flex: 1,
            padding: '0.375rem',
            backgroundColor: 'transparent',
            border: '1px solid var(--color-border)',
            borderRadius: '0.375rem',
            color: 'var(--color-muted)',
            cursor: 'pointer',
            fontSize: '0.75rem',
            transition: 'border-color 0.15s, color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-accent)'
            e.currentTarget.style.color = 'var(--color-accent)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-border)'
            e.currentTarget.style.color = 'var(--color-muted)'
          }}
        >
          ⚙️ Settings
        </button>
      </div>
    </div>
  )
}
