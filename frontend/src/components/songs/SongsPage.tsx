import { useEffect, useEffectEvent, useMemo, useState } from 'react'

import { discardRejection } from '../../async'
import { useLibraryQuery } from '../../hooks/useLibraryQuery'
import { trackArtHue } from '../../trackArt'
import { formatDuration } from '../metrics'
import { describeRun, isActiveRunStatus, RUN_STATUS_LABELS, summarizeRunJourney } from '../runStatus'
import { SONG_BROWSE_SORT_OPTIONS, trackStageSummary } from '../trackListView'
import type { TrackStageSummary } from '../trackListView'
import type { SongsView } from '../../routes'
import type { QueueRunEntry, RunMutationResponse, RunSummary, TrackSummary } from '../../types'

type SongsPageProps = {
  view: SongsView
  tracks: TrackSummary[]
  currentTrackId: string | null
  stagedImportsCount: number
  queueRuns: QueueRunEntry[]
  cancellingRunId: string | null
  retryingRunId: string | null
  dismissingRunId: string | null
  stemCreationReady: boolean
  stemCreationBlockedReason: string
  onViewChange: (view: SongsView) => void
  onOpenTrack: (track: TrackSummary, options?: { runId?: string | null }) => void
  onAddSongs: () => void
  onReviewImports: () => void
  onCancelRun: (runId: string) => Promise<void>
  onRetryRun: (runId: string) => Promise<RunMutationResponse>
  onDismissRun: (runId: string) => Promise<void>
  onBatchCreateStems: (trackIds: string[]) => void
  onBatchExport: (trackIds: string[]) => void
  onBatchDelete: (trackIds: string[]) => void
}

type RowStatus = {
  text: string | null
  tone: 'processing' | 'attn' | 'ready' | null
}

function rowStatusFromStage(stage: TrackStageSummary, track: TrackSummary): RowStatus {
  if (stage.key === 'processing') {
    const run = track.latest_run
    if (run) {
      const status = summarizeRunJourney(run)
      return {
        text: status.progressLabel ?? status.label,
        tone: 'processing',
      }
    }
    return { text: RUN_STATUS_LABELS.queued, tone: 'processing' }
  }
  if (stage.key === 'needs-attention') {
    const run = track.latest_run
    const status = run ? summarizeRunJourney(run) : null
    return {
      text: status?.label ?? 'Stem set failed',
      tone: 'attn',
    }
  }
  if (stage.key === 'needs-stems') return { text: null, tone: null }
  if (stage.key === 'final' || stage.key === 'ready') {
    return {
      text: track.has_custom_mix ? 'Mix adjusted' : 'Ready to mix',
      tone: 'ready',
    }
  }
  return { text: null, tone: null }
}

function WaveformIcon() {
  const bars = [0.28, 0.52, 0.85, 0.65, 0.95, 0.72, 0.44, 0.22]
  const barW = 5
  const gap = 3
  const svgH = 36
  const svgW = bars.length * (barW + gap) - gap
  return (
    <svg
      className="library-onboard-icon"
      width={svgW}
      height={svgH}
      viewBox={`0 0 ${svgW} ${svgH}`}
      aria-hidden
    >
      {bars.map((h, i) => {
        const barH = Math.max(4, h * svgH)
        const x = i * (barW + gap)
        const y = (svgH - barH) / 2
        return <rect key={i} x={x} y={y} width={barW} height={barH} rx={2.5} fill="currentColor" />
      })}
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
      <path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function RowProgressBar({ run }: { run: RunSummary }) {
  const fraction = Math.max(0, Math.min(1, run.progress))
  return (
    <span
      className="song-row-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      aria-label={describeRun(run)}
    >
      <span className="song-row-progress-fill" style={{ transform: `scaleX(${fraction})` }} />
    </span>
  )
}

function QueueStrip({
  draftsCount,
  activeRuns,
  failedRuns,
  cancellingRunId,
  retryingRunId,
  dismissingRunId,
  stemCreationReady,
  stemCreationBlockedReason,
  onReviewImports,
  onOpenRun,
  onCancelRun,
  onRetryRun,
  onDismissRun,
}: {
  draftsCount: number
  activeRuns: QueueRunEntry[]
  failedRuns: QueueRunEntry[]
  cancellingRunId: string | null
  retryingRunId: string | null
  dismissingRunId: string | null
  stemCreationReady: boolean
  stemCreationBlockedReason: string
  onReviewImports: () => void
  onOpenRun: (entry: QueueRunEntry) => void
  onCancelRun: (runId: string) => Promise<void>
  onRetryRun: (runId: string) => Promise<RunMutationResponse>
  onDismissRun: (runId: string) => Promise<void>
}) {
  const activeCount = activeRuns.length
  const failedCount = failedRuns.length
  const attn = failedCount > 0 && draftsCount === 0 && activeCount === 0
  const aggregate =
    activeCount > 0
      ? activeRuns.reduce((sum, entry) => sum + Math.max(0, Math.min(1, entry.run.progress)), 0) / activeCount
      : 0
  // Show the head summary row only when it adds information beyond what the item rows show.
  // A single active run with no drafts/failures is fully described by its own row.
  const showHead = draftsCount > 0 || failedCount > 0 || activeCount > 1
  const summary: string[] = []
  if (draftsCount > 0) summary.push(`${draftsCount} import${draftsCount === 1 ? '' : 's'} to review`)
  if (showHead && activeCount > 0) summary.push(`${activeCount} stem set${activeCount === 1 ? '' : 's'} running`)
  if (failedCount > 0) summary.push(`${failedCount} need${failedCount === 1 ? 's' : ''} attention`)

  const compact = !showHead && activeCount === 1 && failedCount === 0

  return (
    <section className={`library-queue ${attn ? 'is-attn' : ''} ${compact ? 'is-compact' : ''}`}>
      {showHead ? (
        <div className="library-queue-head">
          <span className="library-queue-summary">{summary.join(' · ')}</span>
          {draftsCount > 0 ? (
            <button type="button" className="button-primary" onClick={onReviewImports}>
              Review imports
            </button>
          ) : null}
        </div>
      ) : null}

      {activeCount > 0 ? (
        <>
          {activeCount > 1 ? (
            <div
              className="library-queue-aggregate"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(aggregate * 100)}
              aria-label="Overall stem creation progress"
            >
              <span className="library-queue-aggregate-fill" style={{ transform: `scaleX(${aggregate})` }} />
            </div>
          ) : null}
          <ul className="library-queue-list">
            {activeRuns.map((entry) => {
              const fraction = Math.max(0, Math.min(1, entry.run.progress))
              const pct = Math.round(fraction * 100)
              const label = describeRun(entry.run) || 'Queued'
              const cancelling = cancellingRunId === entry.run.id
              return (
                <li key={entry.run.id} className="library-queue-row">
                  <button type="button" className="library-queue-item" onClick={() => onOpenRun(entry)}>
                    <span className="library-queue-item-title" title={entry.track_title}>
                      {entry.track_title}
                    </span>
                    <span className="library-queue-item-stage">{label}</span>
                    <span className="library-queue-item-bar" aria-hidden>
                      <span className="library-queue-item-fill" style={{ transform: `scaleX(${fraction})` }} />
                    </span>
                    <span className="library-queue-item-pct">{pct}%</span>
                  </button>
                  <button
                    type="button"
                    className="library-queue-cancel"
                    disabled={cancelling}
                    onClick={() => discardRejection(() => onCancelRun(entry.run.id))}
                    aria-label={`Cancel stem creation for ${entry.track_title}`}
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      ) : null}

      {failedCount > 0 ? (
        <ul className="library-queue-list library-queue-failed">
          {failedRuns.map((entry) => {
            const reason = entry.run.error_message?.trim() || entry.run.status_message?.trim() || 'No detail recorded'
            const label = entry.run.status === 'cancelled' ? 'Cancelled' : 'Failed'
            const retrying = retryingRunId === entry.run.id
            const dismissing = dismissingRunId === entry.run.id
            return (
              <li key={entry.run.id} className="library-queue-row">
                <button type="button" className="library-queue-item is-failed" onClick={() => onOpenRun(entry)}>
                  <span className="library-queue-item-title" title={entry.track_title}>
                    {entry.track_title}
                  </span>
                  <span className="library-queue-item-stage">{label}</span>
                  <span className="library-queue-item-reason" title={reason}>
                    {reason}
                  </span>
                </button>
                <div className="library-queue-actions">
                  <button
                    type="button"
                    className="library-queue-cancel"
                    disabled={retrying || dismissing || !stemCreationReady}
                    title={!stemCreationReady ? stemCreationBlockedReason : undefined}
                    onClick={() => discardRejection(() => onRetryRun(entry.run.id))}
                    aria-label={`Retry stem creation for ${entry.track_title}`}
                  >
                    {retrying ? 'Retrying…' : 'Retry'}
                  </button>
                  <button
                    type="button"
                    className="library-queue-cancel library-queue-dismiss"
                    disabled={retrying || dismissing}
                    onClick={() => discardRejection(() => onDismissRun(entry.run.id))}
                    aria-label={`Dismiss ${label.toLowerCase()} queue item for ${entry.track_title}`}
                  >
                    {dismissing ? 'Dismissing…' : 'Dismiss'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}

const TRACK_WAVE_VIEW_WIDTH = 320
const TRACK_WAVE_VIEW_HEIGHT = 40
const TRACK_WAVE_MID = TRACK_WAVE_VIEW_HEIGHT / 2
const TRACK_WAVE_MAX_HALF = TRACK_WAVE_MID - 1

function TrackWaveThumb({ track }: { track: TrackSummary }) {
  const peaks = track.source_peaks
  if (peaks.length === 0) {
    return (
      <svg
        className="track-wave track-wave-empty"
        viewBox={`0 0 ${TRACK_WAVE_VIEW_WIDTH} ${TRACK_WAVE_VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        <line
          x1={0}
          y1={TRACK_WAVE_MID}
          x2={TRACK_WAVE_VIEW_WIDTH}
          y2={TRACK_WAVE_MID}
          strokeDasharray="2 4"
        />
      </svg>
    )
  }
  const barWidth = TRACK_WAVE_VIEW_WIDTH / peaks.length
  return (
    <svg
      className="track-wave"
      viewBox={`0 0 ${TRACK_WAVE_VIEW_WIDTH} ${TRACK_WAVE_VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {peaks.map((peak, index) => {
        const half = Math.max(0.5, Math.min(TRACK_WAVE_MAX_HALF, peak * TRACK_WAVE_MAX_HALF))
        return (
          <rect
            key={index}
            x={index * barWidth}
            y={TRACK_WAVE_MID - half}
            width={Math.max(1, barWidth - 0.6)}
            height={half * 2}
          />
        )
      })}
    </svg>
  )
}

export function SongsPage({
  view,
  tracks,
  currentTrackId,
  stagedImportsCount,
  queueRuns,
  cancellingRunId,
  retryingRunId,
  dismissingRunId,
  stemCreationReady,
  stemCreationBlockedReason,
  onViewChange,
  onOpenTrack,
  onAddSongs,
  onReviewImports,
  onCancelRun,
  onRetryRun,
  onDismissRun,
  onBatchCreateStems,
  onBatchExport,
  onBatchDelete,
}: SongsPageProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectionMode, setSelectionMode] = useState(false)
  const [deleteArmedSelectionKey, setDeleteArmedSelectionKey] = useState<string | null>(null)

  const handleEscapeSelection = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    setSelected(new Set())
    setSelectionMode(false)
    setDeleteArmedSelectionKey(null)
  })

  useEffect(() => {
    if (selected.size === 0 && !selectionMode) return
    window.addEventListener('keydown', handleEscapeSelection)
    return () => window.removeEventListener('keydown', handleEscapeSelection)
  }, [selected.size, selectionMode])

  const {
    browseTracks,
    browseTrackIds,
    activeRuns,
    failedRuns,
    filterTabs,
    stemmableIds,
    exportableIds,
  } = useLibraryQuery(tracks, view, queueRuns)
  const showQueue = stagedImportsCount > 0 || activeRuns.length > 0 || failedRuns.length > 0
  const showFilterTabs = filterTabs.length > 2 // only show when at least 2 distinct stages are present

  const { selectedIds, stemEligible, exportEligible } = useMemo(() => {
    const ids = Array.from(selected).filter((id) => browseTrackIds.has(id))
    return {
      selectedIds: ids,
      stemEligible: ids.filter((id) => stemmableIds.has(id)),
      exportEligible: ids.filter((id) => exportableIds.has(id)),
    }
  }, [browseTrackIds, selected, stemmableIds, exportableIds])
  const selectionKey = useMemo(() => selectedIds.slice().sort().join('|'), [selectedIds])
  const deleteArmed = selectionKey.length > 0 && deleteArmedSelectionKey === selectionKey
  const selectedCount = selectedIds.length
  const stemSkippedCount = selectedCount - stemEligible.length
  const exportSkippedCount = selectedCount - exportEligible.length
  const batchReadiness = [
    stemEligible.length > 0 ? `${stemEligible.length} ready for stem sets` : null,
    exportEligible.length > 0 ? `${exportEligible.length} ready to export a current mix` : null,
    stemEligible.length === 0 && exportEligible.length === 0 ? 'No selected songs are ready for batch actions' : null,
  ].filter(Boolean).join(' · ')
  const selectedVisibleIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const allSelected =
    browseTracks.length > 0 && browseTracks.every((track) => selectedVisibleIdSet.has(track.id))

  useEffect(() => {
    if (!deleteArmed) return
    const id = window.setTimeout(() => setDeleteArmedSelectionKey(null), 4000)
    return () => window.clearTimeout(id)
  }, [deleteArmed])

  function toggleSelect(trackId: string) {
    setDeleteArmedSelectionKey(null)
    setSelectionMode(true)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }

  function toggleAll() {
    setDeleteArmedSelectionKey(null)
    setSelectionMode(true)
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(browseTracks.map((track) => track.id)))
  }

  function clearSelection() {
    setDeleteArmedSelectionKey(null)
    setSelectionMode(false)
    setSelected(new Set())
  }

  function changeBrowseView(nextView: SongsView, options?: { preserveSelection?: boolean }) {
    if (!options?.preserveSelection) clearSelection()
    onViewChange(nextView)
  }

  function toggleSelectionMode() {
    setDeleteArmedSelectionKey(null)
    if (selectionMode) {
      setSelectionMode(false)
      setSelected(new Set())
      return
    }
    setSelectionMode(true)
  }

  function handleCreateStems() {
    if (!stemEligible.length || !stemCreationReady) return
    setDeleteArmedSelectionKey(null)
    onBatchCreateStems(stemEligible)
    setSelected(new Set())
    setSelectionMode(false)
  }

  function handleExport() {
    if (!exportEligible.length) return
    setDeleteArmedSelectionKey(null)
    onBatchExport(exportEligible)
    setSelected(new Set())
    setSelectionMode(false)
  }

  function handleDelete() {
    if (!selectedCount) return
    if (!deleteArmed) {
      setDeleteArmedSelectionKey(selectionKey)
      return
    }
    setDeleteArmedSelectionKey(null)
    onBatchDelete(selectedIds)
    setSelected(new Set())
    setSelectionMode(false)
  }

  const countLabel =
    view.search.trim() && browseTracks.length !== tracks.length
      ? `${browseTracks.length} of ${tracks.length}`
      : view.filter !== 'all'
        ? `${browseTracks.length} of ${tracks.length}`
        : tracks.length > 0
          ? `${tracks.length}`
          : null

  return (
    <section className={`library ${selectionMode ? 'is-selecting' : ''}`}>
      <div className="library-header">
        {showQueue ? (
          <QueueStrip
            draftsCount={stagedImportsCount}
            activeRuns={activeRuns}
            failedRuns={failedRuns}
            cancellingRunId={cancellingRunId}
            retryingRunId={retryingRunId}
            dismissingRunId={dismissingRunId}
            stemCreationReady={stemCreationReady}
            stemCreationBlockedReason={stemCreationBlockedReason}
            onReviewImports={onReviewImports}
            onOpenRun={(entry) => {
              const track = tracks.find((item) => item.id === entry.track_id)
              if (track) onOpenTrack(track, { runId: entry.run.id })
            }}
            onCancelRun={onCancelRun}
            onRetryRun={onRetryRun}
            onDismissRun={onDismissRun}
          />
        ) : null}

        {tracks.length > 0 ? (
          <div className="library-controls">
            <div className="library-toolbar">
              <div className="library-search-wrap">
                <input
                  type="search"
                  className="library-search"
                  placeholder="Search songs"
                  aria-label="Search songs"
                  value={view.search}
                  onChange={(event) => changeBrowseView({ ...view, search: event.target.value })}
                />
                {view.search ? (
                  <button
                    type="button"
                    className="library-search-clear"
                    onClick={() => changeBrowseView({ ...view, search: '' })}
                    aria-label="Clear search"
                  >
                    <ClearIcon />
                  </button>
                ) : null}
              </div>
              <div className="library-sort-group" role="group" aria-label="Sort songs">
                {SONG_BROWSE_SORT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`library-sort-btn ${view.sort === option.value ? 'is-active' : ''}`}
                    aria-pressed={view.sort === option.value}
                    title={option.label}
                    onClick={() =>
                      changeBrowseView({ ...view, sort: option.value }, { preserveSelection: true })
                    }
                  >
                    {option.shortLabel}
                  </button>
                ))}
              </div>
              {countLabel ? (
                <span className="library-count" aria-live="polite">{countLabel}</span>
              ) : null}
              {browseTracks.length > 0 ? (
                <button
                  type="button"
                  className={`library-select-btn ${selectionMode ? 'is-active' : ''}`}
                  onClick={toggleSelectionMode}
                >
                  {selectionMode ? 'Done' : 'Select songs'}
                </button>
              ) : null}
              {selectionMode && browseTracks.length > 0 ? (
                <button type="button" className="library-select-btn" onClick={toggleAll}>
                  {allSelected ? 'Clear all' : 'Select all'}
                </button>
              ) : null}
            </div>

            {showFilterTabs ? (
              <div className="library-filters" role="tablist" aria-label="Filter songs">
                {filterTabs.map((tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    role="tab"
                    aria-selected={view.filter === tab.value}
                    className={`library-filter ${view.filter === tab.value ? 'is-active' : ''}`}
                    onClick={() => changeBrowseView({ ...view, filter: tab.value })}
                  >
                    {tab.label}
                    {tab.value !== 'all' ? (
                      <span className="library-filter-count">{tab.count}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="library-body">
      {browseTracks.length > 0 ? (
        <div className="library-list" role="list">
          {browseTracks.map((track) => {
            const stage = trackStageSummary(track)
            const status = rowStatusFromStage(stage, track)
            const isSelected = selected.has(track.id)
            const isCurrent = currentTrackId === track.id
            const initials = track.title.trim().slice(0, 1).toUpperCase() || 'S'
            const meta = [track.artist, formatDuration(track.duration_seconds)]
              .filter(Boolean)
              .join(' · ')

            const activeRun =
              track.latest_run && isActiveRunStatus(track.latest_run.status) ? track.latest_run : null
            const latestRun = track.latest_run
            const opensWorkspace = stage.key !== 'needs-stems'
            const readyActionLabel = 'Open mixer'
            const createActionLabel = 'Create first stem set'
            const rowActionBlocked = !opensWorkspace && !stemCreationReady
            const rowActionTitle = rowActionBlocked
              ? stemCreationBlockedReason
              : opensWorkspace
                ? `Open ${track.title}`
                : `${createActionLabel} for ${track.title}`
            const rowActionLabel = rowActionBlocked
              ? `Stem creation unavailable for ${track.title}: ${stemCreationBlockedReason}`
              : opensWorkspace
                ? `Open ${track.title}`
                : `${createActionLabel} for ${track.title}`
            const showProgressBar = !!activeRun
            return (
              <div
                key={track.id}
                role="listitem"
                className={`song-row ${isSelected ? 'is-selected' : ''} ${isCurrent ? 'is-current' : ''}`}
              >
                <label
                  className="song-row-check"
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(track.id)}
                    aria-label={`Select ${track.title}`}
                  />
                </label>
                <button
                  type="button"
                  className="song-row-open"
                  disabled={!selectionMode && rowActionBlocked}
                  title={rowActionTitle}
                  aria-label={rowActionLabel}
                  onClick={() => {
                    if (selectionMode) {
                      toggleSelect(track.id)
                      return
                    }
                    if (opensWorkspace) {
                      onOpenTrack(track)
                      return
                    }
                    if (stage.key === 'needs-stems' && stemCreationReady) {
                      onBatchCreateStems([track.id])
                    }
                  }}
                >
                  <span
                    className="song-row-art"
                    aria-hidden
                    data-stage={stage.key}
                    style={{ '--art-hue': String(trackArtHue(track.title)) } as React.CSSProperties}
                  >
                    {track.thumbnail_url ? <img src={track.thumbnail_url} alt="" loading="lazy" /> : initials}
                    {stage.key === 'processing' || stage.key === 'needs-attention' ? (
                      <span className="song-row-art-dot" aria-hidden />
                    ) : null}
                  </span>
                  <span className="song-row-copy">
                    <span className="song-row-title">{track.title}</span>
                    <span className="song-row-sub">{meta}</span>
                  </span>
                  <span className="song-row-wave-cell" aria-hidden={!showProgressBar}>
                    {showProgressBar ? <RowProgressBar run={activeRun!} /> : <TrackWaveThumb track={track} />}
                  </span>
                </button>
                <div className="song-row-meta">
                  {stage.key === 'needs-stems' ? (
                    <div className="song-row-actions">
                      <button
                        type="button"
                        className="song-row-stem-action"
                        disabled={!stemCreationReady}
                        title={!stemCreationReady ? stemCreationBlockedReason : undefined}
                        onClick={() => onBatchCreateStems([track.id])}
                        aria-label={`${createActionLabel} for ${track.title}`}
                      >
                        {createActionLabel}
                      </button>
                    </div>
                  ) : stage.key === 'needs-attention' && latestRun ? (
                    <button
                      type="button"
                      className="song-row-retry-action"
                      disabled={retryingRunId === latestRun.id || !stemCreationReady}
                      title={!stemCreationReady ? stemCreationBlockedReason : undefined}
                      onClick={() => discardRejection(() => onRetryRun(latestRun.id))}
                      aria-label={`Retry stem creation for ${track.title}`}
                    >
                      {retryingRunId === latestRun.id ? 'Retrying…' : 'Retry'}
                    </button>
                  ) : stage.key === 'processing' ? (
                    <span className="song-row-status is-processing">
                      {status.text ?? 'Creating stems'}
                    </span>
                  ) : stage.key === 'ready' || stage.key === 'final' ? (
                    <div className="song-row-actions">
                      {status.text ? (
                        <span className={`song-row-status ${status.tone ? `is-${status.tone}` : ''}`}>
                          {status.text}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="song-row-ready-action"
                        onClick={() => onOpenTrack(track)}
                        aria-label={`${readyActionLabel} for ${track.title}`}
                      >
                        {readyActionLabel}
                      </button>
                      <button
                        type="button"
                        className="song-row-secondary-action"
                        onClick={() => onBatchExport([track.id])}
                        aria-label={`Export current mix for ${track.title}`}
                      >
                        Export mix
                      </button>
                    </div>
                  ) : status.text ? (
                    <span className={`song-row-status ${status.tone ? `is-${status.tone}` : ''}`}>
                      {status.text}
                    </span>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {browseTracks.length === 0 ? (
        tracks.length > 0 ? (
          <div className="library-empty">
            {view.filter !== 'all' ? (
              <>
                <strong>Nothing in this filter</strong>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => changeBrowseView({ ...view, filter: 'all' })}
                >
                  Show all songs
                </button>
              </>
            ) : (
              <>
                <strong>No results for "{view.search}"</strong>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => changeBrowseView({ ...view, search: '' })}
                >
                  Clear search
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="library-empty library-empty-onboard">
            <WaveformIcon />
            <strong>Add your first song</strong>
            <p>Add audio, create a stem set, adjust the mix, then export.</p>
            <button type="button" className="button-primary" onClick={onAddSongs}>
              Add songs
            </button>
          </div>
        )
      ) : null}

      {selectedCount > 0 ? (
        <div className="batch-bar" role="toolbar" aria-label="Batch actions">
          <span className="batch-bar-copy" aria-live="polite">
            <strong>{selectedCount} selected</strong>
            <span>{batchReadiness}</span>
          </span>
          <div className="batch-bar-spacer" />
          {!deleteArmed ? (
            <>
              <button type="button" className="button-link" onClick={clearSelection}>
                Clear
              </button>
              {stemEligible.length > 0 ? (
                <button
                  type="button"
                  className="button-primary"
                  disabled={!stemCreationReady}
                  onClick={handleCreateStems}
                  title={
                    !stemCreationReady
                      ? stemCreationBlockedReason
                      : stemSkippedCount > 0
                        ? `${stemSkippedCount} selected song${stemSkippedCount === 1 ? ' is' : 's are'} already creating stems.`
                        : undefined
                  }
                >
                  Queue stem sets
                </button>
              ) : null}
              {exportEligible.length > 0 ? (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={handleExport}
                  title={exportSkippedCount > 0 ? `${exportSkippedCount} selected song${exportSkippedCount === 1 ? ' is' : 's are'} not ready to export a current mix yet.` : undefined}
                >
                  Export current mixes
                </button>
              ) : null}
              <button type="button" className="button-secondary" onClick={handleDelete}>
                Delete {selectedCount}
              </button>
            </>
          ) : (
            <>
              <span className="batch-bar-delete-prompt">Permanently delete {selectedCount} song{selectedCount === 1 ? '' : 's'}?</span>
              <button type="button" className="button-danger" onClick={handleDelete}>
                Delete
              </button>
              <button type="button" className="button-link" onClick={() => setDeleteArmedSelectionKey(null)}>
                Cancel
              </button>
            </>
          )}
        </div>
      ) : null}
      </div>
    </section>
  )
}
