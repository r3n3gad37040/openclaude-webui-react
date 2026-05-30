import React from 'react'
import type { Message, GeneratedMedia } from '../../types/index.js'

interface MessageBubbleProps {
  message: Message
  isLatest: boolean
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isLatest }) => {
  const isUser = message.role === 'user'

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginTop: '0.5rem',
        marginBottom: '0.5rem',
        animation: 'slideUp 0.2s ease-out',
      }}
    >
      <div style={{
        maxWidth: message.generated_media?.length ? '90%' : '85%',
        padding: '0.5rem 0.875rem',
        borderRadius: '0.75rem',
        borderTopLeftRadius: isUser ? '0.75rem' : '0.125rem',
        borderTopRightRadius: isUser ? '0.125rem' : '0.75rem',
        backgroundColor: isUser ? 'var(--color-user-bubble)' : 'var(--color-assistant-bubble)',
        fontSize: '0.875rem',
        lineHeight: 1.625,
        wordBreak: 'break-word',
      }}>
        {message.content && message.content !== '​' && (
          <div className={isUser ? '' : 'prose'} style={{ whiteSpace: 'pre-wrap' }}>
            {message.content}
          </div>
        )}

        {/* Generated media */}
        {message.generated_media?.map((media, i) => (
          <div key={i} className="not-prose" style={{ marginTop: '0.5rem' }}>
            {media.media_type === 'image' ? (
              <img
                src={media.url.startsWith('http') ? media.url : `/api/media/serve?path=${encodeURIComponent(media.url)}`}
                alt={media.alt || 'Generated image'}
                style={{ maxWidth: '100%', borderRadius: '0.75rem', cursor: 'zoom-in' }}
                loading="lazy"
              />
            ) : (
              <video
                controls
                src={media.url.startsWith('http') ? media.url : `/api/media/serve?path=${encodeURIComponent(media.url)}`}
                style={{ maxWidth: '100%', borderRadius: '0.75rem' }}
              />
            )}
          </div>
        ))}

        {/* Tool calls */}
        {message.tool_calls?.map((tc, i) => (
          <div key={i} style={{
            marginTop: '0.375rem',
            padding: '0.375rem 0.5rem',
            backgroundColor: 'var(--color-code-bg)',
            borderRadius: '0.375rem',
            fontSize: '0.75rem',
            fontFamily: 'JetBrains Mono, monospace',
            color: 'var(--color-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
          }}>
            <span style={{ color: 'var(--color-accent)' }}>⚙</span>
            <span>{tc.name}</span>
          </div>
        ))}

        {/* Token/cost metadata */}
        {(message.input_tokens || message.output_tokens || message.estimated_cost) && (
          <div style={{
            marginTop: '0.375rem',
            fontSize: '10px',
            fontFamily: 'JetBrains Mono, monospace',
            color: 'var(--color-muted)',
            opacity: 0.7,
            display: 'flex',
            gap: '0.75rem',
          }}>
            {message.input_tokens ? <span>↑ {fmt(message.input_tokens)} in</span> : null}
            {message.output_tokens ? <span>↓ {fmt(message.output_tokens)} out</span> : null}
            {message.estimated_cost ? <span>${message.estimated_cost.toFixed(4)}</span> : null}
          </div>
        )}
      </div>
    </div>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}
