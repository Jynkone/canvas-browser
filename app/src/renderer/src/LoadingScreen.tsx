// LoadingScreen.tsx
import { useMemo } from 'react'

interface LoadingScreenProps {
  isVisible: boolean
  progress?: number
  message?: string
}

export function LoadingScreen({
  isVisible,
  progress,
  message = 'Loading your workspace…',
}: LoadingScreenProps) {
  const pct = useMemo(() => {
    if (typeof progress === 'number') return Math.max(0, Math.min(100, progress))
    return undefined
  }, [progress])

  if (!isVisible) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background:
          'radial-gradient(1200px 800px at 20% 10%, #ffffff 0%, #f8fafc 55%, #f2f4f7 100%)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 9999,
        transition: 'opacity 400ms ease-out',
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        {/* Brand */}
        <div
          style={{
            fontSize: '52px',
            fontWeight: 300,
            letterSpacing: '4px',
            color: '#111827',
            marginBottom: 36,
          }}
        >
          Paper
        </div>

        {/* Paper Crumple: a single sheet that lightly crumples and smooths */}
        <div
          style={{
            position: 'relative',
            width: 180,
            height: 220,
            margin: '0 auto 36px',
            filter: 'drop-shadow(0 20px 30px rgba(0,0,0,0.10))',
            perspective: 800,
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 8,
              background:
                'linear-gradient(180deg, #ffffff 0%, #ffffff 60%, #fafafa 100%)',
              border: '1px solid rgba(0,0,0,0.06)',
              overflow: 'hidden',
              transformOrigin: 'center',
              animation: 'paperCrumple 3.6s ease-in-out infinite',
            }}
          >
            {/* Soft “fibers” / grain */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background:
                  'radial-gradient(120px 60px at 40% 20%, rgba(0,0,0,0.04), transparent 60%), radial-gradient(160px 80px at 70% 60%, rgba(0,0,0,0.035), transparent 60%)',
                mixBlendMode: 'multiply',
                opacity: 0.35,
                animation: 'paperShift 7s ease-in-out infinite',
              }}
            />
            {/* Light creases */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background:
                  'linear-gradient(115deg, rgba(0,0,0,0.06) 0%, transparent 35%), linear-gradient(-135deg, rgba(0,0,0,0.05) 0%, transparent 40%)',
                opacity: 0.25,
                animation: 'creasePulse 3.6s ease-in-out infinite',
              }}
            />
            {/* Content lines */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                padding: '18px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                opacity: 0.85,
              }}
            >
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div
                  // eslint-disable-next-line react/no-array-index-key
                  key={i}
                  style={{
                    height: 2,
                    background:
                      'linear-gradient(90deg, rgba(0,0,0,0.12), rgba(0,0,0,0.05))',
                    borderRadius: 1,
                    width: i === 0 ? '70%' : i === 5 ? '45%' : '92%',
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Progress */}
        <div
          style={{
            width: 280,
            height: 3,
            background: 'rgba(17, 24, 39, 0.12)',
            borderRadius: 3,
            overflow: 'hidden',
            margin: '0 auto 18px',
          }}
        >
          <div
            style={{
              height: '100%',
              background:
                'linear-gradient(90deg, #2563eb, #7c3aed, #06b6d4)',
              width: pct !== undefined ? `${pct}%` : '30%',
              transition: pct !== undefined ? 'width 320ms ease-out' : 'none',
              animation: pct === undefined ? 'progressSweep 2.2s ease-in-out infinite' : 'none',
            }}
          />
        </div>

        {/* Message */}
        <div
          style={{
            fontSize: 14,
            color: 'rgba(17, 24, 39, 0.65)',
            letterSpacing: 0.3,
            userSelect: 'none',
          }}
        >
          {message}
        </div>
      </div>

      {/* Keyframes */}
      <style>{`
        @keyframes paperCrumple {
          0%   { transform: translateZ(0) rotate(0deg) scale(1); border-radius: 8px; }
          20%  { transform: translateZ(0) rotate(-1.2deg) scale(0.995); }
          35%  { transform: translateZ(0) rotate(1.2deg) scale(0.992); border-radius: 14px; }
          50%  { transform: translateZ(0) rotate(0deg) scale(0.988); border-radius: 16px; }
          65%  { transform: translateZ(0) rotate(0.6deg) scale(0.992); border-radius: 12px; }
          80%  { transform: translateZ(0) rotate(-0.6deg) scale(0.997); border-radius: 9px; }
          100% { transform: translateZ(0) rotate(0deg) scale(1); border-radius: 8px; }
        }

        @keyframes paperShift {
          0%, 100% { transform: translate3d(0,0,0); }
          50%      { transform: translate3d(6px, -5px, 0); }
        }

        @keyframes creasePulse {
          0%   { opacity: 0.22; filter: blur(0.0px); }
          40%  { opacity: 0.35; filter: blur(0.3px); }
          70%  { opacity: 0.28; filter: blur(0.15px); }
          100% { opacity: 0.22; filter: blur(0.0px); }
        }

        @keyframes progressSweep {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(360%); }
          100% { transform: translateX(360%); }
        }
      `}</style>
    </div>
  )
}
