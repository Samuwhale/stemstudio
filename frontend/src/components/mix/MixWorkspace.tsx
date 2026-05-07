import { useEffect, useEffectEvent, useRef, useState } from 'react'

import { discardRejection } from '../../async'
import { useProcessingSelection } from '../../hooks/useProcessingSelection'
import { ConfirmInline } from '../feedback/ConfirmInline'
import { MixExportPopover } from './MixExportPopover'
import { MixPanel, type MixSaveStatus } from './MixPanel'
import { StemSelectionPicker } from '../StemSelectionPicker'
import { formatDuration } from '../metrics'
import { RUN_STATUS_SHORT_LABELS, isActiveRunStatus, summarizeRunJourney } from '../runStatus'
import { listVisibleRuns, resolveSelectedRun } from '../../runSelection'
import { isStemKind } from '../../stems'
import { trackArtHue } from '../../trackArt'
import type {
  QualityOption,
  RevealFolderInput,
  RunDetail,
  RunMixStemEntry,
  RunMutationResponse,
  RunProcessingConfigInput,
  StemOption,
  TrackDetail,
} from '../../types'

type MixWorkspaceProps = {
  track: TrackDetail | null
  selectedRunId: string | null
  stemOptions: StemOption[]
  qualityOptions: QualityOption[]
  defaultSelection: RunProcessingConfigInput
  defaultBitrate: string
  creatingRun: boolean
  cancellingRunId: string | null
  retryingRunId: string | null
  deletingRunId: string | null
  settingKeeper: boolean
  savingMixRunId: string | null
  updatingTrack: boolean
  hasPrevTrack: boolean
  hasNextTrack: boolean
  trackPosition: { index: number; total: number } | null
  onBackToSongs: () => void
  onNavigatePrev: () => void
  onNavigateNext: () => void
  onSelectRun: (runId: string) => void
  onCreateRun: (trackId: string, processing: RunProcessingConfigInput) => Promise<RunMutationResponse>
  onCancelRun: (runId: string) => Promise<void>
  onRetryRun: (runId: string) => Promise<RunMutationResponse>
  onDeleteRun: (runId: string) => Promise<void>
  onSetKeeper: (trackId: string, runId: string | null) => Promise<void>
  onSaveMix: (trackId: string, runId: string, stems: RunMixStemEntry[]) => Promise<void>
  onUpdateTrack: (trackId: string, payload: { title?: string; artist?: string | null }) => Promise<void>
  onDeleteTrack: (trackId: string) => void
  onReveal: (payload: RevealFolderInput) => void | Promise<void>
  onOpenShortcuts: () => void
  onError: (message: string) => void
}

type Popover = null | 'stemSets' | 'export' | 'menu'
const IDLE_MIX_SAVE_STATUS: MixSaveStatus = { state: 'idle', dirty: false, error: null }

type StemCreateControlProps = {
  stemOptions: StemOption[]
  qualityOptions: QualityOption[]
  defaultSelection: RunProcessingConfigInput
  creatingRun: boolean
  buttonLabel?: string
  onCreateRun: (processing: RunProcessingConfigInput) => void
}

function StemCreateControl({
  stemOptions,
  qualityOptions,
  defaultSelection,
  creatingRun,
  buttonLabel = 'Create first stem set',
  onCreateRun,
}: StemCreateControlProps) {
  const [selection, setSelection] = useProcessingSelection(defaultSelection)

  return (
    <div className="mix-stem-select">
      <StemSelectionPicker
        value={selection}
        stemOptions={stemOptions}
        qualityOptions={qualityOptions}
        disabled={creatingRun}
        compact
        onChange={setSelection}
      />
      <button
        type="button"
        className="button-primary"
        disabled={creatingRun || selection.stems.length === 0}
        onClick={() => onCreateRun(selection)}
      >
        {creatingRun ? 'Queueing…' : buttonLabel}
      </button>
    </div>
  )
}

const RETRYABLE_STATUSES = new Set(['failed', 'cancelled'])

function formatStatus(status: string) {
  return RUN_STATUS_SHORT_LABELS[status] ?? status
}

function formatTimestampShort(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function isMixableRun(run: RunDetail) {
  return run.status === 'completed' && run.artifacts.some((artifact) => isStemKind(artifact.kind))
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

function stemSetSummary(run: RunDetail): string {
  return run.processing.label
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Ellipsis() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden>
      <circle cx="4" cy="9" r="1.4" />
      <circle cx="9" cy="9" r="1.4" />
      <circle cx="14" cy="9" r="1.4" />
    </svg>
  )
}

function BackArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M8.5 3L4.5 7L8.5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronUp() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M3 9L7 5L11 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M3 5L7 9L11 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
      <path d="M7.5 1.5l2 2L3 10H1V8L7.5 1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StemCreateIcon() {
  // Five bars representing isolated stem tracks — vocals, drums, bass, piano, other
  const bars = [
    { y: 8,  h: 20 }, // vocals — medium
    { y: 2,  h: 32 }, // drums — tall
    { y: 12, h: 12 }, // bass — short
    { y: 0,  h: 36 }, // main — full height
    { y: 6,  h: 24 }, // other — medium-tall
  ]
  return (
    <svg width="56" height="36" viewBox="0 0 56 36" fill="none" aria-hidden className="mix-blocked-icon">
      {bars.map(({ y, h }, i) => (
        <rect
          key={i}
          x={i * 12}
          y={y}
          width="8"
          height={h}
          rx="2"
          fill="currentColor"
          className={`mix-blocked-icon-bar mix-blocked-icon-bar-${i + 1}`}
        />
      ))}
    </svg>
  )
}

// Looping waveform visualiser shown during active stem separation
function ProcessingWaveIcon() {
  // Heights as fractions of viewBox (0–1), arranged to look like a waveform
  const bars = [0.45, 0.78, 0.55, 1.0, 0.65, 0.88, 0.42, 0.70, 0.52]
  const barW = 7
  const gap = 4
  const svgH = 36
  const svgW = bars.length * (barW + gap) - gap
  return (
    <svg
      className="mix-processing-icon"
      width={svgW}
      height={svgH}
      viewBox={`0 0 ${svgW} ${svgH}`}
      aria-hidden
    >
      {bars.map((h, i) => {
        const barH = Math.max(4, h * svgH)
        const x = i * (barW + gap)
        const y = (svgH - barH) / 2
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={barH}
            rx={3.5}
            fill="currentColor"
            className={`mix-processing-bar mix-processing-bar-${i + 1}`}
          />
        )
      })}
    </svg>
  )
}

type StemSetsPopoverProps = {
  track: TrackDetail
  selectedRun: RunDetail | null
  stemOptions: StemOption[]
  qualityOptions: QualityOption[]
  defaultSelection: RunProcessingConfigInput
  creatingRun: boolean
  cancellingRunId: string | null
  retryingRunId: string | null
  deletingRunId: string | null
  settingKeeper: boolean
  onClose: () => void
  onSelectRun: (runId: string) => void
  onCreateRun: (processing: RunProcessingConfigInput) => Promise<RunMutationResponse>
  onCancelRun: (runId: string) => Promise<void>
  onRetryRun: (runId: string) => Promise<RunMutationResponse>
  onDeleteRun: (runId: string) => Promise<void>
  onSetKeeper: (runId: string | null) => Promise<void>
}

function StemSetsPopover({
  track,
  selectedRun,
  stemOptions,
  qualityOptions,
  defaultSelection,
  creatingRun,
  cancellingRunId,
  retryingRunId,
  deletingRunId,
  settingKeeper,
  onClose,
  onSelectRun,
  onCreateRun,
  onCancelRun,
  onRetryRun,
  onDeleteRun,
  onSetKeeper,
}: StemSetsPopoverProps) {
  const keeperId = track.keeper_run_id
  const selectedIsKeeper = !!selectedRun && keeperId === selectedRun.id
  const canDeleteSelected =
    !!selectedRun && selectedRun.id !== keeperId && !isActiveRunStatus(selectedRun.status)
  const [selection, setSelection] = useProcessingSelection(defaultSelection)
  const runs = listVisibleRuns(track.runs)

  async function generate() {
    const result = await onCreateRun(selection)
    onSelectRun(result.run.id)
    onClose()
  }

  async function retry(run: RunDetail) {
    const result = await onRetryRun(run.id)
    onSelectRun(result.run.id)
    onClose()
  }

  function stateLabel(run: RunDetail): string {
    if (isActiveRunStatus(run.status)) {
      const status = summarizeRunJourney(run)
      return status.progressLabel ?? status.label
    }
    if (RETRYABLE_STATUSES.has(run.status)) {
      return retryingRunId === run.id ? 'Retrying…' : 'Retry'
    }
    return 'Ready'
  }

  function detailLine(run: RunDetail): string {
    if (isActiveRunStatus(run.status)) return summarizeRunJourney(run).detail
    const when = formatTimestampShort(run.updated_at)
    if (run.status === 'completed') return when
    return `${formatStatus(run.status)} · ${when}`
  }

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} aria-hidden />
      <div className="popover popover-right popover-wide" role="dialog" aria-label="Stem sets">
        <div className="popover-title">Stem sets</div>
        <div className="popover-section">
          <StemSelectionPicker
            value={selection}
            stemOptions={stemOptions}
            qualityOptions={qualityOptions}
            disabled={creatingRun}
            compact
            onChange={setSelection}
          />
          <button
            type="button"
            className="button-primary"
            disabled={creatingRun || selection.stems.length === 0}
            onClick={() => discardRejection(generate)}
          >
            {creatingRun ? 'Queueing…' : 'Create another stem set'}
          </button>
        </div>
        {runs.length > 0 ? (
          <div className="popover-list" role="list">
            {runs.map((run) => {
              const isActive = run.id === selectedRun?.id
              const isPreferred = run.id === keeperId
              const disabled = RETRYABLE_STATUSES.has(run.status) && retryingRunId === run.id
              return (
                <button
                  key={run.id}
                  type="button"
                  className={`popover-row ${isActive ? 'is-active' : ''} ${isPreferred ? 'is-preferred' : ''}`}
                  disabled={disabled}
                  onClick={() => {
                    if (RETRYABLE_STATUSES.has(run.status)) discardRejection(() => retry(run))
                    else {
                      onSelectRun(run.id)
                      onClose()
                    }
                  }}
                >
                  <span className="popover-row-copy">
                    <strong>
                      {isPreferred ? (
                        <span className="popover-row-star" aria-label="Preferred stem set" title="Preferred stem set">★</span>
                      ) : null}
                      {run.processing.label}
                    </strong>
                    <span>{detailLine(run)}</span>
                  </span>
                  <span className="popover-row-state">{stateLabel(run)}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        {selectedRun && isActiveRunStatus(selectedRun.status) ? (
          <ConfirmInline
            label="Cancel"
            pendingLabel="Cancelling…"
            confirmLabel="Stop"
            cancelLabel="Keep running"
            prompt="Stop creating stems?"
            pending={cancellingRunId === selectedRun.id}
            onConfirm={() => onCancelRun(selectedRun.id)}
          />
        ) : null}

        {selectedRun && selectedRun.status === 'completed' ? (
          <div className="popover-foot">
            <button
              type="button"
              className="button-secondary"
              disabled={settingKeeper}
              onClick={() =>
                discardRejection(() => onSetKeeper(selectedIsKeeper ? null : selectedRun.id))
              }
            >
              {selectedIsKeeper ? 'Clear preferred' : 'Use as preferred'}
            </button>
            {canDeleteSelected ? (
              <ConfirmInline
                label="Delete stem set"
                pendingLabel="Deleting…"
                confirmLabel="Delete"
                cancelLabel="Keep it"
                prompt="Delete this stem set?"
                pending={deletingRunId === selectedRun.id}
                onConfirm={() => onDeleteRun(selectedRun.id)}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  )
}

type OverflowMenuProps = {
  track: TrackDetail
  onClose: () => void
  onReveal: () => void | Promise<void>
  onDeleteTrack: () => void
  onOpenShortcuts: () => void
}

function OverflowMenu({ track, onClose, onReveal, onDeleteTrack, onOpenShortcuts }: OverflowMenuProps) {
  const hasActiveRun = listVisibleRuns(track.runs).some((run) => isActiveRunStatus(run.status))

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} aria-hidden />
      <div className="popover popover-right" role="dialog" aria-label="Track options">
        <div className="menu">
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              discardRejection(onReveal)
              onClose()
            }}
          >
            Reveal source folder
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => { onOpenShortcuts(); onClose() }}
          >
            Keyboard shortcuts
          </button>
          <div className="menu-sep" aria-hidden />
          <ConfirmInline
            label={hasActiveRun ? 'Finish active stem set first' : 'Delete song…'}
            pendingLabel="Deleting…"
            confirmLabel={`Delete "${track.title}"`}
            cancelLabel="Keep"
            prompt={`Delete "${track.title}" and all its stem sets?`}
            disabled={hasActiveRun}
            onConfirm={async () => {
              onDeleteTrack()
              onClose()
            }}
          />
        </div>
      </div>
    </>
  )
}

export function MixWorkspace(props: MixWorkspaceProps) {
  if (!props.track) {
    return (
      <section className="mix">
        <div className="mix-empty">
          <strong>No song selected</strong>
          <p>Open a song from your library to mix and export its stems.</p>
          <button type="button" className="button-secondary" onClick={props.onBackToSongs}>
            Back to library
          </button>
        </div>
      </section>
    )
  }
  return <MixWorkspaceContent key={props.track.id} {...props} track={props.track} />
}

function MixWorkspaceContent({
  track,
  selectedRunId,
  stemOptions,
  qualityOptions,
  defaultSelection,
  defaultBitrate,
  creatingRun,
  cancellingRunId,
  retryingRunId,
  deletingRunId,
  settingKeeper,
  savingMixRunId,
  updatingTrack,
  hasPrevTrack,
  hasNextTrack,
  trackPosition,
  onBackToSongs,
  onNavigatePrev,
  onNavigateNext,
  onSelectRun,
  onCreateRun,
  onCancelRun,
  onRetryRun,
  onDeleteRun,
  onSetKeeper,
  onSaveMix,
  onUpdateTrack,
  onDeleteTrack,
  onReveal,
  onOpenShortcuts,
  onError,
}: MixWorkspaceProps & { track: TrackDetail }) {
  const visibleRuns = listVisibleRuns(track.runs)
  const [popover, setPopover] = useState<Popover>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editArtist, setEditArtist] = useState('')
  const titleCommitRef = useRef(false)
  const editTitleRef = useRef<HTMLInputElement>(null)
  const editArtistRef = useRef<HTMLInputElement>(null)

  const selectedRun = resolveSelectedRun(track, selectedRunId)
  const selectedRunStateId = selectedRun?.id ?? null
  const [mixSaveState, setMixSaveState] = useState(() => ({
    runId: selectedRunStateId,
    status: IDLE_MIX_SAVE_STATUS,
  }))
  const mixSaveStatus =
    mixSaveState.runId === selectedRunStateId ? mixSaveState.status : IDLE_MIX_SAVE_STATUS
  const mixable = selectedRun ? isMixableRun(selectedRun) : false
  const mixSavePending = mixable && (mixSaveStatus.state === 'pending' || mixSaveStatus.state === 'saving')
  const mixSaveFailed = mixable && mixSaveStatus.state === 'failed'
  const exportBlockedByMixSave = mixSavePending || mixSaveFailed
  const canExport = !!selectedRun && selectedRun.status === 'completed' && !exportBlockedByMixSave
  const stemSetLabel = selectedRun ? stemSetSummary(selectedRun) : ''
  const activeStemSet = selectedRun && isActiveRunStatus(selectedRun.status)
  const selectedRunIsKeeper = !!selectedRun && selectedRun.id === track.keeper_run_id
  const progressPct = activeStemSet ? Math.round(selectedRun.progress * 100) : null
  const completedRunCount = visibleRuns.filter((run) => run.status === 'completed').length
  const selectedRunQueued = selectedRun?.status === 'queued'
  const taskStatus = selectedRun ? summarizeRunJourney(selectedRun) : null
  const showStemSetControl = visibleRuns.length > 0
  const taskbarLabel = mixSavePending
    ? 'Saving mix changes'
    : mixSaveFailed
      ? 'Mix save failed'
      : taskStatus?.label ?? 'Create first stem set'
  const taskbarDetail = mixSavePending
    ? 'Export will be available after the latest levels and mutes are saved.'
    : mixSaveFailed
      ? mixSaveStatus.error ?? 'Retry the save from the mixer before exporting.'
      : mixable
        ? 'Export starts with the current mix. Add separated stem files only when needed.'
        : taskStatus?.detail ?? 'Choose which stems to create, then adjust the separated tracks here.'

  function handleMixSaveStatusChange(status: MixSaveStatus) {
    setMixSaveState({ runId: selectedRunStateId, status })
  }

  // Focus title input when edit mode opens
  useEffect(() => {
    if (editingTitle) editTitleRef.current?.focus()
  }, [editingTitle])

  function startEditTitle() {
    titleCommitRef.current = false
    setEditTitle(track.title)
    setEditArtist(track.artist ?? '')
    setEditingTitle(true)
  }

  function commitTitleEdit() {
    if (titleCommitRef.current) return
    titleCommitRef.current = true
    const nextTitle = editTitle.trim()
    setEditingTitle(false)
    if (nextTitle && (nextTitle !== track.title || (editArtist.trim() || null) !== track.artist)) {
      discardRejection(() => onUpdateTrack(track.id, {
        title: nextTitle,
        artist: editArtist.trim() || null,
      }))
    }
  }

  function cancelTitleEdit() {
    titleCommitRef.current = false
    setEditingTitle(false)
  }

  const handleWorkspaceKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (editingTitle) {
        cancelTitleEdit()
        return
      }
      if (popover) setPopover(null)
      return
    }
    if (isEditableTarget(event.target)) return
    if (event.metaKey || event.ctrlKey || event.altKey) return

    if (event.key === 'e') {
      if (!canExport) return
      event.preventDefault()
      setPopover((current) => (current === 'export' ? null : 'export'))
      return
    }
    if (event.key === 'v') {
      if (!selectedRun) return
      event.preventDefault()
      setPopover((current) => (current === 'stemSets' ? null : 'stemSets'))
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleWorkspaceKeyDown)
    return () => window.removeEventListener('keydown', handleWorkspaceKeyDown)
  }, [])

  function createRunAndSelect(processing: RunProcessingConfigInput) {
    discardRejection(async () => {
      const result = await onCreateRun(track.id, processing)
      onSelectRun(result.run.id)
    })
  }

  return (
    <section className="mix">
      <header className="mix-top">
        <div className="mix-top-nav">
          <button type="button" className="mix-back" onClick={onBackToSongs} title="Back to library (Esc)">
            <BackArrow />
            Library
          </button>
          {trackPosition && trackPosition.total > 1 ? (
            <div className="mix-nav-stepper" role="group" aria-label="Browse tracks">
              <button
                type="button"
                className="icon-button mix-nav-btn"
                onClick={onNavigatePrev}
                disabled={!hasPrevTrack}
                aria-label="Previous track"
                title="Previous track (k)"
              >
                <ChevronUp />
              </button>
              <span className="mix-nav-position" aria-live="polite">
                {trackPosition.index + 1}<span aria-hidden>/</span>{trackPosition.total}
              </span>
              <button
                type="button"
                className="icon-button mix-nav-btn"
                onClick={onNavigateNext}
                disabled={!hasNextTrack}
                aria-label="Next track"
                title="Next track (j)"
              >
                <ChevronDown />
              </button>
            </div>
          ) : null}
        </div>
        <div className="mix-top-title">
          <span
            className="mix-top-art"
            aria-hidden
            style={{ '--art-hue': String(trackArtHue(track.title)) } as React.CSSProperties}
          >
            {track.thumbnail_url
              ? <img src={track.thumbnail_url} alt="" loading="lazy" />
              : track.title.trim().slice(0, 1).toUpperCase() || 'S'}
          </span>
          <div className="mix-top-title-stack">
            {editingTitle ? (
              <div
                className="mix-top-rename"
                onBlur={(e) => {
                  if (e.relatedTarget instanceof HTMLElement && e.currentTarget.contains(e.relatedTarget)) return
                  commitTitleEdit()
                }}
              >
                <input
                  ref={editTitleRef}
                  type="text"
                  className="mix-top-rename-title"
                  value={editTitle}
                  disabled={updatingTrack}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); editArtistRef.current?.focus() }
                    if (e.key === 'Escape') { e.preventDefault(); cancelTitleEdit() }
                  }}
                  aria-label="Song title"
                />
                <input
                  ref={editArtistRef}
                  type="text"
                  className="mix-top-rename-artist"
                  value={editArtist}
                  placeholder="Artist (optional)"
                  disabled={updatingTrack}
                  onChange={(e) => setEditArtist(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitTitleEdit() }
                    if (e.key === 'Escape') { e.preventDefault(); cancelTitleEdit() }
                  }}
                  aria-label="Song artist"
                />
              </div>
            ) : (
              <button
                type="button"
                className="mix-top-title-copy"
                disabled={updatingTrack}
                onClick={startEditTitle}
                title="Click to rename"
                aria-label={`Rename — ${track.title}`}
              >
                <strong>{track.title}</strong>
                <span className="mix-top-title-sub">
                  {(track.artist || track.duration_seconds) ? (
                    <span className="mix-top-artist">
                      {[track.artist, formatDuration(track.duration_seconds)].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                  <span className="mix-top-edit-icon" aria-hidden><PencilIcon /></span>
                </span>
              </button>
            )}
          </div>
        </div>
        <div className="mix-top-actions">
          <span className="popover-anchor">
            <button
              type="button"
              className="button-primary"
              onClick={() => {
                if (!canExport) return
                setPopover(popover === 'export' ? null : 'export')
              }}
              disabled={!canExport}
              aria-haspopup="dialog"
              aria-expanded={popover === 'export'}
              title={
                mixSavePending
                  ? 'Waiting for the latest mix changes to save.'
                  : mixSaveFailed
                    ? 'Fix the mix save error before exporting.'
                    : canExport
                      ? 'Export the current mix or separated stems (e)'
                      : 'Export unlocks after the selected stem set is ready.'
              }
            >
              {mixSavePending ? 'Saving mix…' : 'Export current mix'}
            </button>
            {popover === 'export' && selectedRun && canExport ? (
              <MixExportPopover
                track={track}
                run={selectedRun}
                defaultBitrate={defaultBitrate}
                onClose={() => setPopover(null)}
                onReveal={onReveal}
                onError={onError}
              />
            ) : null}
          </span>
          {showStemSetControl ? (
            <span className="popover-anchor">
              <button
                type="button"
                className={`mix-version-pill ${popover === 'stemSets' ? 'is-open' : ''} ${selectedRunIsKeeper ? 'is-keeper' : ''}`}
                onClick={() => setPopover(popover === 'stemSets' ? null : 'stemSets')}
                aria-haspopup="dialog"
                aria-expanded={popover === 'stemSets'}
                title={selectedRunIsKeeper ? 'Preferred stem set — click to manage (v)' : 'Stem sets — create, switch, or manage (v)'}
              >
                {activeStemSet ? <span className="mix-version-dot" data-state="active" aria-hidden /> : null}
                {!activeStemSet && selectedRunIsKeeper ? (
                  <span className="mix-version-star" aria-hidden>★</span>
                ) : null}
                <span className="mix-version-pill-label">{selectedRun ? stemSetLabel : 'Choose stem set'}</span>
                {selectedRunQueued ? (
                  <span className="mix-version-count">queued</span>
                ) : progressPct !== null ? (
                  <span className="mix-version-count">{progressPct}%</span>
                ) : completedRunCount > 1 ? (
                  <span className="mix-version-count mix-version-count-badge" aria-label={`${completedRunCount} stem sets`}>
                    {completedRunCount}
                  </span>
                ) : null}
                <span className="mix-version-chevron"><Chevron /></span>
              </button>
              {popover === 'stemSets' ? (
                <StemSetsPopover
                  track={track}
                  selectedRun={selectedRun}
                  stemOptions={stemOptions}
                  qualityOptions={qualityOptions}
                  defaultSelection={defaultSelection}
                  creatingRun={creatingRun}
                  cancellingRunId={cancellingRunId}
                  retryingRunId={retryingRunId}
                  deletingRunId={deletingRunId}
                  settingKeeper={settingKeeper}
                  onClose={() => setPopover(null)}
                  onSelectRun={onSelectRun}
                  onCreateRun={(processing) => onCreateRun(track.id, processing)}
                  onCancelRun={onCancelRun}
                  onRetryRun={onRetryRun}
                  onDeleteRun={onDeleteRun}
                  onSetKeeper={(runId) => onSetKeeper(track.id, runId)}
                />
              ) : null}
            </span>
          ) : null}
          <span className="popover-anchor">
            <button
              type="button"
              className="icon-button"
              onClick={() => setPopover(popover === 'menu' ? null : 'menu')}
              aria-haspopup="menu"
              aria-expanded={popover === 'menu'}
              aria-label="Song options"
            >
              <Ellipsis />
            </button>
            {popover === 'menu' ? (
              <OverflowMenu
                key={track.id}
                track={track}
                onClose={() => setPopover(null)}
                onReveal={() => onReveal({ kind: 'track-outputs', track_id: track.id })}
                onDeleteTrack={() => onDeleteTrack(track.id)}
                onOpenShortcuts={onOpenShortcuts}
              />
            ) : null}
          </span>
        </div>
      </header>
      <div className={`mix-status-row ${mixSaveFailed ? 'is-error' : activeStemSet ? 'is-active' : ''}`}>
        <strong>{taskbarLabel}</strong>
        <span>{taskbarDetail}</span>
      </div>

      {selectedRun && mixable ? (
        <MixPanel
          key={`${track.id}:${selectedRun.id}`}
          run={selectedRun}
          saving={savingMixRunId === selectedRun.id}
          onSaveStatusChange={handleMixSaveStatusChange}
          onSave={(stems) => onSaveMix(track.id, selectedRun.id, stems)}
        />
      ) : (
        <div className="mix-blocked">
          {selectedRun ? (
            isActiveRunStatus(selectedRun.status) ? (
              <>
                {selectedRun.status !== 'queued' ? (
                  <ProcessingWaveIcon />
                ) : null}
                <div className="mix-progress-head">
                  <strong>
                    {selectedRun.status === 'queued'
                      ? 'Waiting in queue'
                      : `Creating ${selectedRun.processing.label}`}
                  </strong>
                  {selectedRun.status !== 'queued' && selectedRun.progress > 0 ? (
                    <span className="mix-progress-pct">{Math.round(selectedRun.progress * 100)}%</span>
                  ) : null}
                </div>
                <div
                  className={`mix-progress-bar ${selectedRun.status === 'queued' ? 'is-queued' : ''}`}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(selectedRun.progress * 100)}
                >
                  {selectedRun.status !== 'queued' ? (
                    <span
                      className="mix-progress-fill"
                      style={{
                        '--progress-scale': String(Math.max(0, Math.min(1, selectedRun.progress))),
                      } as React.CSSProperties}
                    />
                  ) : null}
                </div>
                {selectedRun.status_message && selectedRun.status !== 'queued' ? (
                  <p className="mix-progress-hint" aria-live="polite">{selectedRun.status_message}</p>
                ) : null}
                <ConfirmInline
                  label="Cancel"
                  pendingLabel="Cancelling…"
                  confirmLabel="Stop"
                  cancelLabel="Keep running"
                  prompt="Stop creating stems?"
                  pending={cancellingRunId === selectedRun.id}
                  onConfirm={() => onCancelRun(selectedRun.id)}
                />
              </>
            ) : RETRYABLE_STATUSES.has(selectedRun.status) ? (
              <>
                <strong>{selectedRun.processing.label} failed</strong>
                <p>{selectedRun.error_message || 'Retry this stem set, or choose a different one.'}</p>
                <div className="mix-blocked-actions">
                  <button
                    type="button"
                    className="button-primary"
                    disabled={retryingRunId === selectedRun.id}
                    onClick={() =>
                      discardRejection(async () => {
                        const result = await onRetryRun(selectedRun.id)
                        onSelectRun(result.run.id)
                      })
                    }
                  >
                    {retryingRunId === selectedRun.id ? 'Retrying…' : 'Retry'}
                  </button>
                </div>
                <StemCreateControl
                  stemOptions={stemOptions}
                  qualityOptions={qualityOptions}
                  defaultSelection={defaultSelection}
                  creatingRun={creatingRun}
                  buttonLabel="Create another stem set"
                  onCreateRun={createRunAndSelect}
                />
              </>
            ) : (
              <>
                <strong>{selectedRun.processing.label} produced no stems</strong>
                <p>This stem set completed without separated stem files. Choose a different stem set.</p>
                <StemCreateControl
                  stemOptions={stemOptions}
                  qualityOptions={qualityOptions}
                  defaultSelection={defaultSelection}
                  creatingRun={creatingRun}
                  buttonLabel="Create another stem set"
                  onCreateRun={createRunAndSelect}
                />
              </>
            )
          ) : (
            <>
              <StemCreateIcon />
              <strong>Create first stem set</strong>
              <StemCreateControl
                stemOptions={stemOptions}
                qualityOptions={qualityOptions}
                defaultSelection={defaultSelection}
                creatingRun={creatingRun}
                onCreateRun={createRunAndSelect}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}
