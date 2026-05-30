import React, { useState, useEffect, useRef } from 'react'
import { useAutoResize } from '../hooks/useAutoResize.js'
import { useModelCapabilities } from '../hooks/useAutoResize.js'
import { MediaControls } from './MediaControls.js'
import { useStreamStore } from '../stores/streaming.js'
import { useAppStore } from '../stores/app.js'
import type { Model } from '../../types/index.js'

interface InputAreaProps {
  onSend: (message: string) => void
  onCancel: () => void
  onRegenerate: () => void
  models: Model[]
}

export const InputArea: React.FC<InputAreaProps> = ({ onSend, onCancel, onRegenerate, models }) => {
  const [text, setText] = useState('')
  const { ref, resize } = useAutoResize(44, 400)
  const { isStreaming, modelType, mediaParams, setMediaParam } = useStreamStore()
  const { currentModelId } = useAppStore()
  const caps = useModelCapabilities(currentModelId, models)

  const hasModel = !!currentModelId && (caps.isImage || caps.isVideo || caps.isImage || currentModelId.toLowerCase().includes('nous') || currentModelId.toLowerCase().includes('text'))
  const activeModelType = modelType !== 'text' ? modelType : (
    caps.isVideo ? 'video' : caps.isImage ? 'image' : 'text'
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSend = () => {
    if (!text.trim() || isStreaming) return
    onSend(text.trim())
    setText('')
    if (ref.current) {
      ref.current.style.height = 'auto'
    }
  }

  useEffect(() => { resize() }, [text, resize])

  return (
    <div style={{
      borderTop: '1px solid var(--color-border)',
      backgroundColor: 'var(--color-surface)',
      maxWidth: '48rem',
      width: '100%',
      margin: '0 auto',
      borderRadius: '0.75rem',
      border: '1px solid var(--color-border)',
      overflow: 'hidden',
      transition: 'border-color 0.15s',
    }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end' }}>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={activeModelType === 'image' ? 'Describe an image to generate...' : activeModelType === 'video' ? 'Describe a video to generate...' : 'Message OpenClaude...'}
          style={{
            flex: 1,
            padding: '0.75rem 0.75rem 0.5rem 3rem',
            background: 'transparent',
            border: 'none',
            color: 'var(--color-text)',
            fontFamily: 'Inter, sans-serif',
            fontSize: '0.875rem',
            lineHeight: 1.5,
            resize: 'none',
            outline: 'none',
            minHeight: '44px',
            maxHeight: '20rem',
          }}
          rows={1}
          readOnly={isStreaming}
          className="placeholder-muted"
        />
        {/* Send/Cancel button */}
        <div style={{ position: 'absolute', left: '0.625rem', bottom: '0.5rem' }}>
          {isStreaming ? (
            <button
              onClick={onCancel}
              style={{
                width: '1.75rem',
                height: '1.75rem',
                borderRadius: '9999px',
                border: '1px solid var(--color-border)',
                backgroundColor: 'var(--color-bg)',
                color: 'var(--color-text)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.625rem',
              }}
              title="Stop generation"
            >
              ■
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!text.trim()}
              style={{
                width: '1.75rem',
                height: '1.75rem',
                borderRadius: '9999px',
                border: 'none',
                backgroundColor: text.trim() ? 'var(--color-accent)' : 'var(--color-border)',
                color: text.trim() ? 'var(--color-accent-fg)' : 'var(--color-muted)',
                cursor: text.trim() ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.625rem',
                transition: 'background-color 0.15s',
              }}
              title="Send (⌘+Enter)"
            >
              ↑
            </button>
          )}
        </div>

        {/* Regenerate button */}
        {!isStreaming && (
          <button
            onClick={onRegenerate}
            style={{
              position: 'absolute',
              right: '0.5rem',
              bottom: '0.5rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-muted)',
              fontSize: '0.875rem',
              padding: '0.25rem',
            }}
            title="Regenerate"
          >
            ↻
          </button>
        )}
      </div>

      {/* Inline media controls for image/video models */}
      {(caps.isImage || caps.isVideo) && (
        <MediaControls
          modelType={activeModelType}
          resolution={mediaParams.resolution}
          onResolutionChange={(v) => setMediaParam('resolution', v)}
          aspectRatio={mediaParams.aspectRatio}
          onAspectRatioChange={(v) => setMediaParam('aspectRatio', v)}
          videoDuration={mediaParams.videoDuration}
          onVideoDurationChange={(v) => setMediaParam('videoDuration', v)}
        />
      )}
    </div>
  )
}
