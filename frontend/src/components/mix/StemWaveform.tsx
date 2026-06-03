import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

import { formatDuration } from '../metrics'

type StemWaveformProps = {
  peaks: number[]
  currentTime: number
  duration: number
  color?: string
  onSeek?: (seconds: number) => void
  disabled?: boolean
  ariaLabel?: string
}

const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 120
const MID = VIEW_HEIGHT / 2
const MAX_HALF_BAR = MID - 2

export function StemWaveform({
  peaks,
  currentTime,
  duration,
  color,
  onSeek,
  disabled = false,
  ariaLabel,
}: StemWaveformProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const draggingRef = useRef(false)

  const safeDuration = duration > 0 ? duration : 0
  const progress = safeDuration > 0 ? Math.max(0, Math.min(1, currentTime / safeDuration)) : 0
  const barCount = peaks.length
  const barWidth = barCount > 0 ? VIEW_WIDTH / barCount : VIEW_WIDTH
  const interactive = !!onSeek && !disabled && safeDuration > 0

  const style = color ? ({ '--wave-color': color } as React.CSSProperties) : undefined

  function seekFromClientX(clientX: number) {
    const svg = svgRef.current
    if (!svg || !onSeek || safeDuration === 0) return
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onSeek(ratio * safeDuration)
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive) return
    event.preventDefault()
    draggingRef.current = true
    svgRef.current?.setPointerCapture(event.pointerId)
    seekFromClientX(event.clientX)
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!draggingRef.current) return
    seekFromClientX(event.clientX)
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (!draggingRef.current) return
    draggingRef.current = false
    try {
      svgRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      // pointer already released
    }
  }

  return (
    <svg
      ref={svgRef}
      className={`stem-waveform ${interactive ? 'is-interactive' : ''}`}
      style={style}
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      role={interactive ? 'slider' : undefined}
      aria-label={ariaLabel}
      aria-valuemin={interactive ? 0 : undefined}
      aria-valuemax={interactive ? Math.max(1, Math.round(safeDuration)) : undefined}
      aria-valuenow={interactive ? Math.round(currentTime) : undefined}
      aria-valuetext={
        interactive ? `${formatDuration(currentTime)} of ${formatDuration(safeDuration)}` : undefined
      }
      aria-hidden={interactive ? undefined : true}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {barCount === 0 ? (
        <rect
          x={0}
          y={MID - 0.5}
          width={VIEW_WIDTH}
          height={1}
          className="stem-waveform-baseline"
        />
      ) : (
        peaks.map((peak, index) => {
          const x = index * barWidth
          const half = Math.max(0.6, Math.min(MAX_HALF_BAR, peak * MAX_HALF_BAR))
          const bandEnd = (index + 1) / barCount
          const past = bandEnd <= progress
          return (
            <rect
              key={index}
              x={x}
              y={MID - half}
              width={Math.max(1, barWidth - 1)}
              height={half * 2}
              className={past ? 'stem-waveform-bar stem-waveform-bar-past' : 'stem-waveform-bar'}
            />
          )
        })
      )}
      {safeDuration > 0 ? (
        <line
          x1={progress * VIEW_WIDTH}
          x2={progress * VIEW_WIDTH}
          y1={0}
          y2={VIEW_HEIGHT}
          className="stem-waveform-cursor"
        />
      ) : null}
    </svg>
  )
}
