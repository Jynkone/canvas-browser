import React, { useCallback, useEffect, useState } from 'react'

interface NavigationBarProps {
  navState: {
    currentUrl: string
    canGoBack: boolean
    canGoForward: boolean
    title: string
  }
  isLoading: boolean
  onUrlChange: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
}

// Type-safe button keys
const BUTTON_KEYS = {
  BACK: 'back',
  FORWARD: 'forward',
  RELOAD: 'reload'
} as const

type ButtonKey = typeof BUTTON_KEYS[keyof typeof BUTTON_KEYS]

// Style constants with proper typing
const STYLES = {
  NAV_BAR_HEIGHT: 44,
  COLORS: {
    PRIMARY: '#007bff',
    BACKGROUND: '#f0f0f0',
    DISABLED_BACKGROUND: '#e0e0e0',
    DISABLED_TEXT: '#999',
    TEXT: '#333',
    BORDER: '#dee2e6',
    BORDER_BOTTOM: '#adb5bd',
    INPUT_BORDER: '#ced4da',
    INPUT_FOCUS_SHADOW: 'rgba(0, 123, 255, 0.35)',
    INPUT_HOVER_SHADOW: 'rgba(0,0,0,0.12)',
    ACTIVE_BACKGROUND: '#d0e4ff'
  },
  TRANSITIONS: {
    TRANSFORM: 'transform 0.25s cubic-bezier(0.2, 0, 0, 1.2)',
    BACKGROUND: 'background-color 0.25s ease',
    ALL: 'all 0.25s ease'
  },
  ANIMATION_DURATION: 250
} as const

export const NAV_BAR_HEIGHT = STYLES.NAV_BAR_HEIGHT

export const NavigationBar: React.FC<NavigationBarProps> = ({
  navState,
  isLoading,
  onUrlChange,
  onBack,
  onForward,
  onReload
}) => {
  const [urlInput, setUrlInput] = useState(navState.currentUrl)
  const [clicking, setClicking] = useState<ButtonKey | null>(null)

  useEffect(() => {
    setUrlInput(navState.currentUrl)
  }, [navState.currentUrl])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (!trimmed) return

    // Type-safe URL validation
    const isHttpUrl = trimmed.startsWith('http://') || trimmed.startsWith('https://')
    const isDomainLike = trimmed.includes('.')

    if (isHttpUrl) {
      onUrlChange(trimmed)
    } else if (isDomainLike) {
      onUrlChange(`https://${trimmed}`)
    } else {
      onUrlChange(`https://www.google.com/search?q=${encodeURIComponent(trimmed)}`)
    }
  }, [urlInput, onUrlChange])

  // Type-safe styles - exactly like original but with constants
  const baseButton: React.CSSProperties = {
    width: '32px',
    height: '32px',
    border: 'none',
    borderRadius: '4px',
    background: STYLES.COLORS.BACKGROUND,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    color: STYLES.COLORS.TEXT,
    transition: `${STYLES.TRANSITIONS.TRANSFORM}, ${STYLES.TRANSITIONS.BACKGROUND}`,
    userSelect: 'none'
  }

  const disabledButton: React.CSSProperties = {
    ...baseButton,
    background: STYLES.COLORS.DISABLED_BACKGROUND,
    color: STYLES.COLORS.DISABLED_TEXT,
    cursor: 'not-allowed'
  }

  // Helper for buttons - exactly like original logic
  const makeButton = (
    key: ButtonKey,
    label: string,
    handler: () => void,
    disabled: boolean,
    title: string
  ) => {
    const isActive = clicking === key
    return (
      <button
        type="button"
        onPointerDown={() => {
          if (!disabled) {
            setClicking(key)
            handler()
            setTimeout(() => setClicking(null), STYLES.ANIMATION_DURATION)
          }
        }}
        disabled={disabled}
        style={{
          ...(disabled ? disabledButton : baseButton),
          transform: isActive ? 'scale(0.8)' : 'scale(1.0)',
          background: isActive ? STYLES.COLORS.ACTIVE_BACKGROUND : 
                     (disabled ? STYLES.COLORS.DISABLED_BACKGROUND : STYLES.COLORS.BACKGROUND)
        }}
        title={title}
      >
        {label}
      </button>
    )
  }

  return (
    <div
      style={{
        height: `${STYLES.NAV_BAR_HEIGHT}px`,
        width: '100%',
        background: 'linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)',
        border: `1px solid ${STYLES.COLORS.BORDER}`,
        borderBottom: `1px solid ${STYLES.COLORS.BORDER_BOTTOM}`,
        borderRadius: '6px 6px 0 0',
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        gap: '6px',
        boxSizing: 'border-box',
        fontSize: '13px',
        fontFamily: 'system-ui, sans-serif',
        position: 'relative',
        pointerEvents: 'auto',
        zIndex: 1000
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {makeButton(BUTTON_KEYS.BACK, '←', onBack, !navState.canGoBack, 'Go back')}
      {makeButton(BUTTON_KEYS.FORWARD, '→', onForward, !navState.canGoForward, 'Go forward')}
      {makeButton(BUTTON_KEYS.RELOAD, '↻', onReload, false, 'Reload')}

      <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex' }}>
        <input
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="Search or enter address"
          style={{
            flex: 1,
            height: '32px',
            padding: '0 12px',
            border: `1px solid ${STYLES.COLORS.INPUT_BORDER}`,
            borderRadius: '6px',
            outline: 'none',
            fontSize: '13px',
            fontFamily: 'system-ui, sans-serif',
            background: 'white',
            boxSizing: 'border-box',
            transition: STYLES.TRANSITIONS.ALL,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
          onFocus={(e) => {
            e.currentTarget.select()
            e.currentTarget.style.borderColor = STYLES.COLORS.PRIMARY
            e.currentTarget.style.boxShadow = `0 0 6px ${STYLES.COLORS.INPUT_FOCUS_SHADOW}`
            e.currentTarget.style.background = '#ffffff'
            e.currentTarget.style.overflow = 'visible'
            e.currentTarget.style.textOverflow = 'clip'
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = STYLES.COLORS.INPUT_BORDER
            e.currentTarget.style.boxShadow = 'none'
            e.currentTarget.style.background = 'white'
            e.currentTarget.style.overflow = 'hidden'
            e.currentTarget.style.textOverflow = 'ellipsis'
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => {
            e.preventDefault()
            e.currentTarget.select()
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            e.currentTarget.select()
          }}
          onMouseEnter={(e) => {
            if (document.activeElement !== e.currentTarget) {
              e.currentTarget.style.borderColor = '#bbb'
              e.currentTarget.style.background = '#fefefe'
              e.currentTarget.style.boxShadow = `0 0 6px ${STYLES.COLORS.INPUT_HOVER_SHADOW}`
            }
          }}
          onMouseLeave={(e) => {
            if (document.activeElement !== e.currentTarget) {
              e.currentTarget.style.borderColor = STYLES.COLORS.INPUT_BORDER
              e.currentTarget.style.background = 'white'
              e.currentTarget.style.boxShadow = 'none'
            }
          }}
        />
      </form>

      {isLoading && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            height: '2px',
            width: '100%',
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              height: '100%',
              width: '30%',
              background: STYLES.COLORS.PRIMARY,
              animation: 'loadingBar 1.1s linear infinite'
            }}
          />
        </div>
      )}

      <style>
        {`@keyframes loadingBar {
          0% { margin-left: -30%; }
          100% { margin-left: 100%; }
        }`}
      </style>
    </div>
  )
}