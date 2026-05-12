import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { discardRejection } from '../../async'
import type { RunArtifact, RunDetail, RunMixStemEntry } from '../../types'
import { MIX_GAIN_DB_MAX, MIX_GAIN_DB_MIN } from '../../types'
import { compareStemKinds, isStemKind, stemColorFromKind } from '../../stems'
import { Spinner } from '../feedback/Spinner'
import { StemWaveform } from './StemWaveform'
import { useStemMixer } from './useStemMixer'

type MixPanelProps = {
  run: RunDetail
  onSave: (stems: RunMixStemEntry[]) => Promise<void>
  saving: boolean
  onSaveStatusChange?: (state: MixSaveStatus) => void
}

type StemRow = {
  artifact_id: string
  label: string
  url: string
  kind: string
  peaks: number[]
  color: string
  gain_db: number
  muted: boolean
  soloed: boolean
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed'
export type MixSaveStatus = {
  state: SaveState
  dirty: boolean
  error: string | null
}
type QuickMixKind = 'remove-vocals' | 'keep-backing' | 'vocals-only' | 'reset'

type GainFieldProps = {
  gainDb: number
  onCommit: (nextDb: number) => void
  label: string
}

function GainField({ gainDb, onCommit, label }: GainFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!editing) return
    const input = inputRef.current
    if (input) {
      input.focus()
      input.select()
    }
  }, [editing])

  function startEdit() {
    setDraft(gainDb.toFixed(1))
    setEditing(true)
  }

  function commit() {
    const parsed = Number.parseFloat(draft.replace(/[^-0-9.]/g, ''))
    if (Number.isFinite(parsed)) {
      onCommit(clampGain(parsed))
    }
    setEditing(false)
  }

  function cancel() {
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className="stem-row-gain stem-row-gain-edit"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancel()
          }
        }}
        aria-label={`${label} gain in decibels`}
      />
    )
  }

  return (
    <button
      type="button"
      className={`stem-row-gain ${Math.abs(gainDb) < 0.05 ? 'is-zero' : 'is-set'}`}
      onClick={startEdit}
      title={`${label} gain: click to type a value, double-click fader to reset`}
    >
      {formatGain(gainDb)}
    </button>
  )
}

const SAVE_DEBOUNCE_MS = 400
const FADER_STEP = 0.5
const FADER_STEP_FINE = 0.1
const FADER_STEP_COARSE = 3
const STEM_KIND_PREFIX = 'stem:'
const VOCAL_STEMS = new Set(['vocals', 'lead_vocals', 'backing_vocals'])

// 0 dB sits at 66.6667% of the fader track because MIN=-24 and MAX=+12.
// position% = (value - MIN) / (MAX - MIN) * 100
const FADER_RANGE = MIX_GAIN_DB_MAX - MIX_GAIN_DB_MIN
const FADER_CENTER_PCT = (-MIX_GAIN_DB_MIN / FADER_RANGE) * 100

function mixableArtifacts(run: RunDetail): RunArtifact[] {
  return run.artifacts
    .filter((artifact) => isStemKind(artifact.kind))
    .sort((a, b) => {
      const kindOrder = compareStemKinds(a.kind, b.kind)
      if (kindOrder !== 0) return kindOrder
      return a.label.localeCompare(b.label)
    })
}

function initialStems(run: RunDetail): StemRow[] {
  const mixByArtifact = new Map(run.mix.stems.map((entry) => [entry.artifact_id, entry]))
  return mixableArtifacts(run).map((artifact) => {
    const entry = mixByArtifact.get(artifact.id)
    return {
      artifact_id: artifact.id,
      label: artifact.label,
      url: artifact.download_url,
      kind: artifact.kind,
      peaks: artifact.metrics?.peaks ?? [],
      color: stemColorFromKind(artifact.kind),
      gain_db: entry?.gain_db ?? 0,
      muted: entry?.muted ?? false,
      soloed: false,
    }
  })
}

function stemName(kind: string) {
  return kind.startsWith(STEM_KIND_PREFIX) ? kind.slice(STEM_KIND_PREFIX.length) : kind
}

function isVocalStem(stem: StemRow) {
  return VOCAL_STEMS.has(stemName(stem.kind))
}

function isBackingStem(stem: StemRow) {
  return stemName(stem.kind) === 'backing_vocals'
}

function isLeadStem(stem: StemRow) {
  const name = stemName(stem.kind)
  return name === 'lead_vocals' || name === 'vocals'
}

function equalsPersisted(stems: StemRow[], mixStems: RunMixStemEntry[]) {
  const byId = new Map(mixStems.map((entry) => [entry.artifact_id, entry]))
  for (const stem of stems) {
    const persisted = byId.get(stem.artifact_id)
    const persistedGain = persisted?.gain_db ?? 0
    const persistedMuted = persisted?.muted ?? false
    if (Math.abs(stem.gain_db - persistedGain) > 0.01) return false
    if (stem.muted !== persistedMuted) return false
  }
  return true
}

function clampGain(db: number) {
  return Math.max(MIX_GAIN_DB_MIN, Math.min(MIX_GAIN_DB_MAX, db))
}

function formatGain(db: number) {
  if (Math.abs(db) < 0.05) return '0.0 dB'
  const sign = db > 0 ? '+' : ''
  return `${sign}${db.toFixed(1)} dB`
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const remaining = (total % 60).toString().padStart(2, '0')
  return `${minutes}:${remaining}`
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 18 18" fill="currentColor" aria-hidden>
      <path d="M4 2.5v13l12-6.5z" />
    </svg>
  )
}

function PauseGlyph() {
  return (
    <svg viewBox="0 0 18 18" fill="currentColor" aria-hidden>
      <rect x="4" y="3" width="4" height="12" rx="1" />
      <rect x="10" y="3" width="4" height="12" rx="1" />
    </svg>
  )
}

function faderFillStyle(gainDb: number): React.CSSProperties {
  const thumbPct = ((gainDb - MIX_GAIN_DB_MIN) / FADER_RANGE) * 100
  if (gainDb >= 0) {
    return { left: `${FADER_CENTER_PCT}%`, width: `${thumbPct - FADER_CENTER_PCT}%` }
  }
  return { left: `${thumbPct}%`, width: `${FADER_CENTER_PCT - thumbPct}%` }
}

function MixStateLabel({ stems, anySoloed }: { stems: StemRow[]; anySoloed: boolean }) {
  if (anySoloed) {
    const soloed = stems.filter((s) => s.soloed)
    const label =
      soloed.length <= 2
        ? `Preview solo: ${soloed.map((s) => s.label).join(', ')}`
        : `Preview solo: ${soloed.length} stems`
    return (
      <>
        <span className="mix-transport-sep" aria-hidden>·</span>
        <span className="mix-transport-state is-solo" aria-live="polite">{label}</span>
      </>
    )
  }

  const muted = stems.filter((s) => s.muted)
  if (muted.length === 0 || muted.length === stems.length) return null

  const label =
    muted.length <= 2
      ? `${muted.map((s) => s.label).join(', ')} muted`
      : `${stems.length - muted.length} of ${stems.length} active`

  return (
    <>
      <span className="mix-transport-sep" aria-hidden>·</span>
      <span className="mix-transport-state" aria-live="polite">{label}</span>
    </>
  )
}

function QuickMixStrip({
  stems,
  resetAvailable,
  onApply,
}: {
  stems: StemRow[]
  resetAvailable: boolean
  onApply: (kind: QuickMixKind) => void
}) {
  const hasVocals = stems.some(isVocalStem)
  const hasLeadAndBacking = stems.some(isLeadStem) && stems.some(isBackingStem)
  if (!hasVocals && !resetAvailable) return null

  return (
    <div className="mix-presets" aria-label="Mix presets">
      <span className="mix-presets-label">Mix presets</span>
      <div className="mix-presets-actions" role="toolbar" aria-label="Mix presets">
        {hasVocals ? (
          <>
            <button
              type="button"
              className="mix-preset"
              onClick={() => onApply('remove-vocals')}
              title="Mute vocal stems and keep the rest audible in exports."
            >
              Make instrumental
            </button>
            {hasLeadAndBacking ? (
              <button
                type="button"
                className="mix-preset"
                onClick={() => onApply('keep-backing')}
                title="Mute lead vocals while keeping backing vocals in the exported mix."
              >
                Keep backing vocals
              </button>
            ) : null}
            <button
              type="button"
              className="mix-preset"
              onClick={() => onApply('vocals-only')}
              title="Mute non-vocal stems for a vocals-only export."
            >
              Vocals only
            </button>
          </>
        ) : null}
        {resetAvailable ? (
          <button
            type="button"
            className="mix-preset"
            onClick={() => onApply('reset')}
            title="Restore every stem to 0 dB and unmuted."
          >
            Reset
          </button>
        ) : null}
      </div>
      <span className="mix-presets-hint">Presets change export</span>
    </div>
  )
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function MixPanel({ run, onSave, saving, onSaveStatusChange }: MixPanelProps) {
  const [stems, setStems] = useState<StemRow[]>(() => initialStems(run))
  const saveTimerRef = useRef<number | null>(null)
  const pendingSavePayloadRef = useRef<RunMixStemEntry[] | null>(null)
  const latestSaveIdRef = useRef(0)
  const tearingDownRef = useRef(false)
  const [retryPayload, setRetryPayload] = useState<RunMixStemEntry[] | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      tearingDownRef.current = true
      const pendingTimer = saveTimerRef.current
      if (pendingTimer !== null) {
        window.clearTimeout(pendingTimer)
        saveTimerRef.current = null
      }
      const pendingPayload = pendingSavePayloadRef.current
      if (pendingTimer !== null && pendingPayload) {
        discardRejection(() => onSave(pendingPayload))
      }
    }
  }, [onSave])

  // Auto-clear "Saved" indicator after a short delay
  useEffect(() => {
    if (saveState !== 'saved') return
    const id = window.setTimeout(() => setSaveState('idle'), 1800)
    return () => window.clearTimeout(id)
  }, [saveState])

  const dirty = !equalsPersisted(stems, run.mix.stems)

  useEffect(() => {
    onSaveStatusChange?.({ state: saveState, dirty, error: saveError })
  }, [dirty, onSaveStatusChange, saveError, saveState])

  const mixerStems = useMemo(
    () =>
      stems.map((stem) => ({
        artifact_id: stem.artifact_id,
        url: stem.url,
        gain_db: stem.gain_db,
        muted: stem.muted,
        soloed: stem.soloed,
      })),
    [stems],
  )
  const mixer = useStemMixer(mixerStems)

  const playLoading = mixer.loadState === 'loading'
  const playDisabled = mixer.loadState !== 'ready'

  const persistMix = useCallback(
    async (payload: RunMixStemEntry[]) => {
      const saveId = ++latestSaveIdRef.current
      pendingSavePayloadRef.current = payload
      setRetryPayload(payload)
      setSaveState('saving')
      setSaveError(null)

      try {
        await onSave(payload)
        if (tearingDownRef.current || latestSaveIdRef.current !== saveId) return
        pendingSavePayloadRef.current = null
        setRetryPayload(null)
        setSaveState('saved')
      } catch (error) {
        if (tearingDownRef.current || latestSaveIdRef.current !== saveId) return
        setRetryPayload(payload)
        setSaveState('failed')
        setSaveError(error instanceof Error ? error.message : 'Could not save mix changes.')
      }
    },
    [onSave],
  )

  function scheduleSave(next: StemRow[]) {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    const payload: RunMixStemEntry[] = next.map((stem) => ({
      artifact_id: stem.artifact_id,
      gain_db: Math.round(stem.gain_db * 10) / 10,
      muted: stem.muted,
    }))
    pendingSavePayloadRef.current = payload
    setRetryPayload(payload)
    setSaveState('pending')
    setSaveError(null)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      discardRejection(() => persistMix(payload))
    }, SAVE_DEBOUNCE_MS)
  }

  function updateStem(index: number, patch: Partial<StemRow>) {
    setStems((current) => {
      const next = current.map((stem, i) => (i === index ? { ...stem, ...patch } : stem))
      const persistedChanged = patch.gain_db !== undefined || patch.muted !== undefined
      if (persistedChanged) scheduleSave(next)
      return next
    })
  }

  function applyQuickMix(kind: QuickMixKind) {
    setStems((current) => {
      const next = current.map((stem) => {
        if (kind === 'reset') return { ...stem, gain_db: 0, muted: false, soloed: false }
        if (kind === 'remove-vocals') return { ...stem, muted: isVocalStem(stem), soloed: false }
        if (kind === 'vocals-only') return { ...stem, muted: !isVocalStem(stem), soloed: false }
        return { ...stem, muted: isLeadStem(stem) && !isBackingStem(stem), soloed: false }
      })
      scheduleSave(next)
      return next
    })
  }

  const handleTogglePlay = useCallback(() => {
    if (mixer.isPlaying) mixer.pause()
    else mixer.play()
  }, [mixer])

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.code !== 'Space' && event.key !== ' ') return
      if (isTypingTarget(event.target)) return
      if (playDisabled) return
      event.preventDefault()
      handleTogglePlay()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleTogglePlay, playDisabled])

  function handleFaderKey(index: number, current: number, event: ReactKeyboardEvent<HTMLInputElement>) {
    const step =
      event.shiftKey ? FADER_STEP_FINE : event.altKey ? FADER_STEP_COARSE : FADER_STEP
    const key = event.key
    if (key === 'ArrowUp' || key === 'ArrowRight') {
      event.preventDefault()
      updateStem(index, { gain_db: clampGain(current + step) })
    } else if (key === 'ArrowDown' || key === 'ArrowLeft') {
      event.preventDefault()
      updateStem(index, { gain_db: clampGain(current - step) })
    }
  }

  const anySoloed = stems.some((stem) => stem.soloed)
  const resetAvailable = stems.some((stem) => stem.muted || Math.abs(stem.gain_db) >= 0.05)

  const showTransportSave =
    !saveError && (saving || saveState === 'saving' || saveState === 'pending' || saveState === 'saved' || dirty)
  const showErrors = !!saveError || !!mixer.error

  return (
    <>
      <QuickMixStrip stems={stems} resetAvailable={resetAvailable} onApply={applyQuickMix} />
      <div className="mix-rows" role="group" aria-label="Stem mixer" data-audio-loading={playLoading || undefined}>
        {stems.map((stem, index) => {
          const silenced = stem.muted || (anySoloed && !stem.soloed)
          const fillStyle = faderFillStyle(stem.gain_db)

          return (
            <div
              key={stem.artifact_id}
              className={`stem-row ${stem.muted ? 'is-muted' : ''} ${silenced ? 'is-silenced' : ''}`}
              style={{ '--stem-color': stem.color } as React.CSSProperties}
            >
              <div className="stem-row-head">
                <span className="stem-row-dot" aria-hidden />
                <div className="stem-row-label">
                  <strong>{stem.label}</strong>
                  <GainField
                    gainDb={stem.gain_db}
                    onCommit={(next) => updateStem(index, { gain_db: next })}
                    label={stem.label}
                  />
                </div>
                <div className="stem-row-toggles">
                  <button
                    type="button"
                    className={`stem-toggle stem-toggle-mute ${stem.muted ? 'is-active' : ''}`}
                    onClick={() => updateStem(index, { muted: !stem.muted })}
                    aria-pressed={stem.muted}
                    title={stem.muted ? `Unmute ${stem.label}` : `Mute ${stem.label}`}
                  >
                    Mute
                  </button>
                  <button
                    type="button"
                    className={`stem-toggle stem-toggle-solo ${stem.soloed ? 'is-active' : ''}`}
                    onClick={() => updateStem(index, { soloed: !stem.soloed })}
                    aria-pressed={stem.soloed}
                    aria-label={stem.soloed ? `Stop solo preview for ${stem.label}` : `Solo preview ${stem.label}`}
                    title={stem.soloed ? `Stop solo preview for ${stem.label}` : `Solo ${stem.label} in preview. Exports use saved mutes and levels.`}
                  >
                    Solo
                  </button>
                </div>
              </div>
              <div className="stem-row-wave">
                <StemWaveform
                  peaks={stem.peaks}
                  currentTime={mixer.currentTime}
                  duration={mixer.duration}
                  color={stem.color}
                  onSeek={playDisabled ? undefined : mixer.seek}
                  disabled={playDisabled}
                  ariaLabel={`${stem.label} timeline`}
                />
              </div>
              <label className="stem-fader" aria-label={`${stem.label} gain`}>
                <span className="stem-fader-center" aria-hidden />
                <span className="stem-fader-fill" style={fillStyle} aria-hidden />
                <input
                  type="range"
                  min={MIX_GAIN_DB_MIN}
                  max={MIX_GAIN_DB_MAX}
                  step={FADER_STEP_FINE}
                  value={stem.gain_db}
                  onChange={(event) => updateStem(index, { gain_db: Number(event.target.value) })}
                  onKeyDown={(event) => handleFaderKey(index, stem.gain_db, event)}
                  onDoubleClick={() => updateStem(index, { gain_db: 0 })}
                  aria-label={`${stem.label} gain`}
                  title="Double-click to reset · ← → step · Shift: fine · Alt: coarse"
                />
              </label>
            </div>
          )
        })}
      </div>

      <div className="mix-transport">
        <button
          type="button"
          className={`mix-play ${playLoading ? 'is-loading' : ''}`}
          onClick={handleTogglePlay}
          disabled={playDisabled}
          aria-label={playLoading ? 'Loading audio…' : mixer.isPlaying ? 'Pause preview' : 'Play preview'}
          title={playLoading ? undefined : mixer.isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        >
          {playLoading ? <Spinner /> : mixer.isPlaying ? <PauseGlyph /> : <PlayGlyph />}
        </button>
        <input
          type="range"
          className="mix-seekbar"
          min={0}
          max={mixer.duration || 1}
          step={0.01}
          value={mixer.currentTime}
          onChange={(event) => mixer.seek(Number(event.target.value))}
          disabled={playDisabled}
          aria-label="Seek"
          style={{ '--seek-pct': `${mixer.duration > 0 ? ((mixer.currentTime / mixer.duration) * 100).toFixed(1) : 0}%` } as React.CSSProperties}
        />
        <span className="mix-time">
          {formatTime(mixer.currentTime)}
          <span className="mix-time-sep" aria-hidden> / </span>
          <span className="mix-time-total">{formatTime(mixer.duration)}</span>
        </span>
        <MixStateLabel stems={stems} anySoloed={anySoloed} />
        {anySoloed ? (
          <span className="mix-transport-note">Solo only changes preview. Exports use saved mutes and levels.</span>
        ) : null}
        {showTransportSave ? (
          <>
            <span className="mix-transport-sep" aria-hidden>·</span>
            <span
              className={`mix-transport-save ${saveState === 'saved' ? 'is-saved' : ''}`}
              aria-live="polite"
            >
              {saveState === 'saved' ? 'Saved' : 'Saving…'}
            </span>
          </>
        ) : null}
      </div>

      {showErrors ? (
        <div className="mix-footer">
          <div className="mix-errors" role="status" aria-live="polite">
            {saveError ? (
              <span className="mix-save-state is-error">
                {saveError}
                {retryPayload ? (
                  <button
                    type="button"
                    className="button-link"
                    onClick={() => discardRejection(() => persistMix(retryPayload))}
                  >
                    Retry
                  </button>
                ) : null}
              </span>
            ) : null}
            {mixer.error ? <p>{mixer.error}</p> : null}
          </div>
        </div>
      ) : null}
    </>
  )
}
