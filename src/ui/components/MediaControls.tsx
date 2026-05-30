import React from 'react'

interface MediaControlsProps {
  modelType: 'image' | 'video' | 'audio' | 'text'
  resolution: string
  onResolutionChange: (v: string) => void
  aspectRatio: string
  onAspectRatioChange: (v: string) => void
  videoDuration: string
  onVideoDurationChange: (v: string) => void
}

const RESOLUTIONS = [
  { value: '1024x1024', label: '1024×1024 (1:1)' },
  { value: '1024x1536', label: '1024×1536 (2:3)' },
  { value: '1536x1024', label: '1536×1024 (3:2)' },
  { value: '1280x720', label: '1280×720 (16:9)' },
  { value: '720x1280', label: '720×1280 (9:16)' },
  { value: '1920x1080', label: '1920×1080 (HD)' },
  { value: '2048x2048', label: '2048×2048 (Hi-Res)' },
]

const ASPECT_RATIOS = [
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:2', label: '3:2' },
]

const VIDEO_DURATIONS = [
  { value: '3s', label: '3s' },
  { value: '5s', label: '5s' },
  { value: '8s', label: '8s' },
  { value: '10s', label: '10s' },
  { value: '15s', label: '15s' },
]

export const MediaControls: React.FC<MediaControlsProps> = ({
  modelType,
  resolution,
  onResolutionChange,
  aspectRatio,
  onAspectRatioChange,
  videoDuration,
  onVideoDurationChange,
}) => {
  if (modelType === 'text') return null

  const isVideo = modelType === 'video'
  const isImage = modelType === 'image'

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem',
      padding: '0.375rem 0.5rem',
      borderTop: '1px solid var(--color-border)',
      flexWrap: 'wrap',
    }}>
      <span className="animate-spin" style={{
        fontSize: '0.75rem',
        color: 'var(--color-accent)',
        marginRight: '0.25rem',
        display: 'inline-block',
      }}>
        {isVideo ? '🎬' : '🎨'}
      </span>

      {/* Aspect ratio chips (always visible for image/video) */}
      <div style={{ display: 'flex', gap: '0.25rem' }}>
        {ASPECT_RATIOS.map(ar => (
          <button
            key={ar.value}
            onClick={() => onAspectRatioChange(ar.value)}
            style={{
              padding: '0.125rem 0.375rem',
              fontSize: '0.625rem',
              fontFamily: 'JetBrains Mono, monospace',
              border: '1px solid',
              borderColor: aspectRatio === ar.value ? 'var(--color-accent)' : 'var(--color-border)',
              borderRadius: '0.25rem',
              backgroundColor: aspectRatio === ar.value ? 'var(--color-accent)' : 'transparent',
              color: aspectRatio === ar.value ? 'var(--color-accent-fg)' : 'var(--color-muted)',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {ar.label}
          </button>
        ))}
      </div>

      {/* Resolution dropdown (image models) */}
      {isImage && (
        <select
          value={resolution}
          onChange={(e) => onResolutionChange(e.target.value)}
          style={{
            padding: '0.125rem 0.375rem',
            fontSize: '0.625rem',
            fontFamily: 'JetBrains Mono, monospace',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: '0.25rem',
            color: 'var(--color-muted)',
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          {RESOLUTIONS.map(r => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      )}

      {/* Video duration chips */}
      {isVideo && (
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {VIDEO_DURATIONS.map(vd => (
            <button
              key={vd.value}
              onClick={() => onVideoDurationChange(vd.value)}
              style={{
                padding: '0.125rem 0.375rem',
                fontSize: '0.625rem',
                fontFamily: 'JetBrains Mono, monospace',
                border: '1px solid',
                borderColor: videoDuration === vd.value ? 'var(--color-accent)' : 'var(--color-border)',
                borderRadius: '0.25rem',
                backgroundColor: videoDuration === vd.value ? 'var(--color-accent)' : 'transparent',
                color: videoDuration === vd.value ? 'var(--color-accent-fg)' : 'var(--color-muted)',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {vd.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
