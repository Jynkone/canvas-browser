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

  // NEW: fit-screen toggle
  fitMode: boolean
  onToggleFit: () => void
}

// Type-safe button keys
const BUTTON_KEYS = {
  BACK: 'back',
  FORWARD: 'forward',
  RELOAD: 'reload',
  FIT: 'fit',
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
  },
  TRANSITIONS: {
    TRANSFORM: 'transform 0.25s cubic-bezier(0.2, 0, 0, 1.2)',
    BACKGROUND: 'background-color 0.25s ease',
    ALL: 'all 0.25s ease',
  },
} as const

export const NAV_BAR_HEIGHT = STYLES.NAV_BAR_HEIGHT

// Type-safe input focus state
interface InputFocusState {
  isFocused: boolean
  isHovered: boolean
}

export const NavigationBar: React.FC<NavigationBarProps> = ({
  navState,
  isLoading,
  onUrlChange,
  onBack,
  onForward,
  onReload,
  fitMode,
  onToggleFit,
}) => {
  const [urlInput, setUrlInput] = useState(navState.currentUrl)
  const [activeButton, setActiveButton] = useState<ButtonKey | null>(null)
  const [inputState, setInputState] = useState<InputFocusState>({
    isFocused: false,
    isHovered: false,
  })

  useEffect(() => {
    setUrlInput(navState.currentUrl)
  }, [navState.currentUrl])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = urlInput.trim()
      if (!trimmed) return

      const isHttpUrl = trimmed.startsWith('http://') || trimmed.startsWith('https://')
      const isDomainLike = trimmed.includes('.')

      if (isHttpUrl) {
        onUrlChange(trimmed)
      } else if (isDomainLike) {
        onUrlChange(`https://${trimmed}`)
      } else {
        onUrlChange(`https://www.google.com/search?q=${encodeURIComponent(trimmed)}`)
      }
    },
    [urlInput, onUrlChange]
  )

  interface ButtonConfig {
    key: ButtonKey
    label: string
    handler: () => void
    disabled: boolean
    title: string
  }

  const buttonConfigs: ButtonConfig[] = [
    {
      key: BUTTON_KEYS.BACK,
      label: '←',
      handler: onBack,
      disabled: !navState.canGoBack,
      title: 'Go back',
    },
    {
      key: BUTTON_KEYS.FORWARD,
      label: '→',
      handler: onForward,
      disabled: !navState.canGoForward,
      title: 'Go forward',
    },
    {
      key: BUTTON_KEYS.RELOAD,
      label: '↻',
      handler: onReload,
      disabled: false,
      title: 'Reload',
    },
  ]

  const getButtonStyle = (config: ButtonConfig): React.CSSProperties => {
    const isActive = activeButton === config.key
    const baseStyle: React.CSSProperties = {
      width: '32px',
      height: '32px',
      border: 'none',
      borderRadius: '4px',
      cursor: config.disabled ? 'not-allowed' : 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '14px',
      transition: `${STYLES.TRANSITIONS.TRANSFORM}, ${STYLES.TRANSITIONS.BACKGROUND}`,
      userSelect: 'none',
    }

    if (config.disabled) {
      return {
        ...baseStyle,
        background: STYLES.COLORS.DISABLED_BACKGROUND,
        color: STYLES.COLORS.DISABLED_TEXT,
        transform: 'scale(1.0)',
      }
    }

    return {
      ...baseStyle,
      background: isActive ? '#d0e4ff' : STYLES.COLORS.BACKGROUND,
      color: STYLES.COLORS.TEXT,
      transform: isActive ? 'scale(0.8)' : 'scale(1.0)',
    }
  }

  const getFitButtonStyle = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      height: '32px',
      padding: '0 10px',
      borderRadius: '6px',
      border: '1px solid #cfd4da',
      background: fitMode ? '#d0e4ff' : '#f8f9fa',
      color: STYLES.COLORS.TEXT,
      cursor: 'pointer',
      fontSize: '12px',
      userSelect: 'none',
      transition: STYLES.TRANSITIONS.ALL,
    }
    return base
  }

  const getInputStyle = (): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      flex: 1,
      height: '32px',
      padding: '0 12px',
      borderRadius: '6px',
      outline: 'none',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
      background: 'white',
      boxSizing: 'border-box',
      transition: STYLES.TRANSITIONS.ALL,
    }

    if (inputState.isFocused) {
      return {
        ...baseStyle,
        border: `1px solid ${STYLES.COLORS.PRIMARY}`,
        boxShadow: `0 0 6px ${STYLES.COLORS.INPUT_FOCUS_SHADOW}`,
        whiteSpace: 'nowrap',
        overflow: 'visible',
        textOverflow: 'clip',
      }
    }

    if (inputState.isHovered) {
      return {
        ...baseStyle,
        border: '1px solid #bbb',
        background: '#fefefe',
        boxShadow: `0 0 6px ${STYLES.COLORS.INPUT_HOVER_SHADOW}`,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }
    }

    return {
      ...baseStyle,
      border: `1px solid ${STYLES.COLORS.INPUT_BORDER}`,
      boxShadow: 'none',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }
  }

  const handleButtonPress = (config: ButtonConfig) => {
    if (config.disabled) return
    setActiveButton(config.key)
    config.handler()
    setTimeout(() => setActiveButton(null), 250)
  }

  return (
    <div data-nav-root="1"
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
        zIndex: 1000,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {buttonConfigs.map((config) => (
        <button
          key={config.key}
          type="button"
          onPointerDown={() => handleButtonPress(config)}
          disabled={config.disabled}
          style={getButtonStyle(config)}
          title={config.title}
        >
          {config.label}
        </button>
      ))}

      <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex' }}>
        <input
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="Search or enter address"
          style={getInputStyle()}
          onFocus={(e) => {
            e.currentTarget.select()
            setInputState((prev) => ({ ...prev, isFocused: true }))
          }}
          onBlur={() => {
            setInputState((prev) => ({ ...prev, isFocused: false }))
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
          onMouseEnter={() => {
            if (!inputState.isFocused) {
              setInputState((prev) => ({ ...prev, isHovered: true }))
            }
          }}
          onMouseLeave={() => {
            setInputState((prev) => ({ ...prev, isHovered: false }))
          }}
        />
      </form>

      {/* Right side: Fit screen toggle */}
<button
  type="button"
  aria-label={fitMode ? 'Exit fit' : 'Fit screen'}
  title={fitMode ? 'Exit fit' : 'Fit screen'}
  onPointerDown={onToggleFit}
  style={getFitButtonStyle()}
>
  {fitMode ? '⤡' : '⤢'}
</button>


      {isLoading && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            height: '2px',
            width: '100%',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: '30%',
              background: STYLES.COLORS.PRIMARY,
              animation: 'loadingBar 1.1s linear infinite',
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
