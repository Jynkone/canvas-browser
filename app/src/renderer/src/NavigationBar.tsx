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

export const NAV_BAR_HEIGHT = 44

export const NavigationBar: React.FC<NavigationBarProps> = ({
  navState,
  isLoading,
  onUrlChange,
  onBack,
  onForward,
  onReload
}) => {
  const [urlInput, setUrlInput] = useState(navState.currentUrl)
  const [clicking, setClicking] = useState<string | null>(null)

  useEffect(() => {
    setUrlInput(navState.currentUrl)
  }, [navState.currentUrl])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (!trimmed) return

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      onUrlChange(trimmed)
    } else if (trimmed.includes('.')) {
      onUrlChange(`https://${trimmed}`)
    } else {
      onUrlChange(`https://www.google.com/search?q=${encodeURIComponent(trimmed)}`)
    }
  }, [urlInput, onUrlChange])

  // --- Styles ---
  const baseButton: React.CSSProperties = {
    width: '32px',
    height: '32px',
    border: 'none',
    borderRadius: '4px',
    background: '#f0f0f0',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    color: '#333',
    transition: 'transform 0.25s cubic-bezier(0.2, 0, 0, 1.2), background-color 0.25s ease',
    userSelect: 'none'
  }
  const disabledButton: React.CSSProperties = {
    ...baseButton,
    background: '#e0e0e0',
    color: '#999',
    cursor: 'not-allowed'
  }

  // --- Helper for buttons ---
  const makeButton = (
    key: string,
    label: string,
    handler: () => void,
    disabled?: boolean,
    title?: string
  ) => {
    const isActive = clicking === key
    return (
      <button
        type="button"
        onPointerDown={() => {
          if (!disabled) {
            setClicking(key)
            handler()
            setTimeout(() => setClicking(null), 250)
          }
        }}
        disabled={disabled}
        style={{
          ...(disabled ? disabledButton : baseButton),
          transform: isActive ? 'scale(0.8)' : 'scale(1.0)',
          background: isActive ? '#d0e4ff' : (disabled ? disabledButton.background : baseButton.background)
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
        height: `${NAV_BAR_HEIGHT}px`,
        width: '100%',
        background: 'linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)',
        border: '1px solid #dee2e6',
        borderBottom: '1px solid #adb5bd',
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
      {makeButton('back', '←', onBack, !navState.canGoBack, 'Go back')}
      {makeButton('forward', '→', onForward, !navState.canGoForward, 'Go forward')}
      {makeButton('reload', '↻', onReload, false, 'Reload')}

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
            border: '1px solid #ced4da',
            borderRadius: '6px',
            outline: 'none',
            fontSize: '13px',
            fontFamily: 'system-ui, sans-serif',
            background: 'white',
            boxSizing: 'border-box',
            transition: 'all 0.25s ease',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
          onFocus={(e) => {
            e.currentTarget.select()
            e.currentTarget.style.borderColor = '#007bff'
            e.currentTarget.style.boxShadow = '0 0 6px rgba(0, 123, 255, 0.35)'
            e.currentTarget.style.background = '#ffffff'
            e.currentTarget.style.overflow = 'visible'
            e.currentTarget.style.textOverflow = 'clip'
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = '#ced4da'
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
              e.currentTarget.style.boxShadow = '0 0 6px rgba(0,0,0,0.12)'
            }
          }}
          onMouseLeave={(e) => {
            if (document.activeElement !== e.currentTarget) {
              e.currentTarget.style.borderColor = '#ced4da'
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
              background: '#007bff',
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