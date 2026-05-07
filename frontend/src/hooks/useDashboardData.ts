import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'

import {
  backfillMetrics,
  batchDeleteTracks,
  cancelRun,
  cleanupExportBundles,
  cleanupNonKeeperRunsLibrary,
  cleanupTempStorage,
  confirmImportDrafts,
  createRun,
  dismissRun,
  deleteRun,
  discardImportDraft,
  flushPendingLibraryCleanup,
  flushPendingTrackDeletes,
  getActiveRuns,
  getDiagnostics,
  getSettings,
  getStorageOverview,
  getTrack,
  getTracks,
  listImportDrafts,
  resetLibrary,
  resolveLocalImport,
  resolveYouTubeImport,
  retryRun,
  revealFolder,
  setKeeperRun,
  isApiError,
  updateImportDraft,
  updateRunMix,
  updateSettings,
  updateTrack,
} from '../api'
import { discardRejection } from '../async'
import type { Toast, ToastAction, ToastTone } from '../components/feedback/ToastStack'
import { isActiveRunStatus } from '../components/runStatus'
import type {
  BatchDeleteResponse,
  ConfirmImportDraftsInput,
  ConfirmImportDraftsResponse,
  Diagnostics,
  ExportBundleCleanupResponse,
  ImportDraft,
  LibraryResetResponse,
  NonKeeperCleanupResponse,
  QueueRunEntry,
  RevealFolderInput,
  RunMixStemEntry,
  RunMutationResponse,
  RunProcessingConfigInput,
  Settings,
  StorageOverview,
  TempCleanupResponse,
  TrackDetail,
  TrackSummary,
  UpdateImportDraftInput,
} from '../types'

const IDLE_REFRESH_MS = 3000
const ACTIVE_REFRESH_MS = 1000
const MAX_REFRESH_MS = 30000
const DELETE_UNDO_MS = 5000
const PURGE_UNDO_MS = 5000

type ConnectionState = 'ready' | 'syncing' | 'offline'

export type Connection = {
  state: ConnectionState
  consecutiveFailures: number
  lastSyncAt: number
  nextRetryAt: number | null
  lastError: string | null
}

const INITIAL_CONNECTION: Connection = {
  state: 'syncing',
  consecutiveFailures: 0,
  lastSyncAt: 0,
  nextRetryAt: null,
  lastError: null,
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return 'Unexpected application error.'
}

function reusesCompletedStemSet(result: RunMutationResponse) {
  return result.run.status === 'completed'
}

function describeCreateRunToast(trackLabel: string, result: RunMutationResponse) {
  if (reusesCompletedStemSet(result)) {
    return `Reused the matching stem set for ${trackLabel}.`
  }
  return `Queued stems for ${trackLabel}.`
}

function describeRetryRunToast(trackLabel: string, result: RunMutationResponse) {
  if (reusesCompletedStemSet(result)) {
    return `Reused the matching stem set for ${trackLabel}.`
  }
  return `Queued a retry for ${trackLabel}.`
}

function describeBatchCreateRunToast(results: PromiseSettledResult<RunMutationResponse>[]) {
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<RunMutationResponse> => result.status === 'fulfilled',
  )
  const queued = fulfilled.filter((result) => !reusesCompletedStemSet(result.value)).length
  const reused = fulfilled.length - queued
  const failed = results.length - fulfilled.length

  if (failed === results.length) {
    const firstError = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    return {
      tone: 'error' as const,
      message: getErrorMessage(firstError?.reason),
    }
  }

  const parts: string[] = []
  if (queued > 0) parts.push(`queued ${queued} stem set${queued === 1 ? '' : 's'}`)
  if (reused > 0) parts.push(`reused ${reused} matching stem set${reused === 1 ? '' : 's'}`)
  if (failed > 0) parts.push(`${failed} failed`)

  return {
    tone: failed > 0 ? ('info' as const) : ('success' as const),
    message: `${parts.join(' · ')}.`,
  }
}

function hasActiveWork(track: TrackDetail | null, queueSize: number) {
  if (queueSize > 0) return true
  return !!track?.runs.some((run) => isActiveRunStatus(run.status))
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function clearTimer(timerRef: MutableRefObject<number | null>) {
  if (timerRef.current === null) return
  window.clearTimeout(timerRef.current)
  timerRef.current = null
}

async function loadTrackDetail(trackId: string) {
  try {
    return await getTrack(trackId)
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null
    throw error
  }
}

function resolveRefreshInterval(track: TrackDetail | null, queueSize: number) {
  return hasActiveWork(track, queueSize) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS
}

function describeBatchDeleteResult(result: BatchDeleteResponse): { tone: ToastTone; message: string } {
  const deleted = result.deleted_track_count
  const blocked = result.blocked_track_ids.length
  const missing = result.missing_track_ids.length

  if (blocked === 0 && missing === 0) {
    return {
      tone: 'success',
      message: `Deleted ${deleted} track${deleted === 1 ? '' : 's'}.`,
    }
  }

  const details: string[] = []
  if (deleted > 0) details.push(`Deleted ${deleted}`)
  if (blocked > 0) {
    details.push(
      blocked === 1
        ? '1 blocked by queued or running stem creation'
        : `${blocked} blocked by queued or running stem creation`,
    )
  }
  if (missing > 0) details.push(missing === 1 ? '1 already missing' : `${missing} already missing`)

  return {
    tone: deleted > 0 ? 'info' : 'error',
    message: `${details.join(' · ')}.`,
  }
}

export function useDashboardData(selection: { trackId: string | null }) {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [storageOverview, setStorageOverview] = useState<StorageOverview | null>(null)
  const [tracks, setTracks] = useState<TrackSummary[]>([])
  const [drafts, setDrafts] = useState<ImportDraft[]>([])
  const [queueRuns, setQueueRuns] = useState<QueueRunEntry[]>([])
  const [workerOnline, setWorkerOnline] = useState<boolean>(true)

  const [selectedTrack, setSelectedTrack] = useState<TrackDetail | null>(null)

  const [toasts, setToasts] = useState<Toast[]>([])
  const [resolvingYoutubeImport, setResolvingYoutubeImport] = useState(false)
  const [resolvingLocalImport, setResolvingLocalImport] = useState(false)
  const [confirmingDrafts, setConfirmingDrafts] = useState(false)
  const [creatingRun, setCreatingRun] = useState(false)
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null)
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null)
  const [dismissingRunId, setDismissingRunId] = useState<string | null>(null)
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [cleaningTempStorage, setCleaningTempStorage] = useState(false)
  const [cleaningExportBundles, setCleaningExportBundles] = useState(false)
  const [cleaningLibraryRuns, setCleaningLibraryRuns] = useState(false)
  const [resettingLibrary, setResettingLibrary] = useState(false)
  const [connection, setConnection] = useState<Connection>(INITIAL_CONNECTION)
  const [settingKeeper, setSettingKeeper] = useState(false)
  const [backfillingMetrics, setBackfillingMetrics] = useState(false)
  const [savingMixRunId, setSavingMixRunId] = useState<string | null>(null)
  const [updatingTrack, setUpdatingTrack] = useState(false)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set())

  const selectedTrackRef = useRef<TrackDetail | null>(selectedTrack)
  const routeTrackIdRef = useRef<string | null>(selection.trackId)
  const refreshIntervalMsRef = useRef<number>(IDLE_REFRESH_MS)
  const lastPollAtRef = useRef<number>(0)
  const inFlightRef = useRef<boolean>(false)
  const pendingDeleteTimerRef = useRef<number | null>(null)
  const pendingDeleteIdsRef = useRef<Set<string>>(pendingDeleteIds)
  const pendingLibraryCleanupTimerRef = useRef<number | null>(null)
  const selectedTrackRequestIdRef = useRef(0)
  const queueSizeRef = useRef(queueRuns.length)
  const prevQueueRunsRef = useRef<QueueRunEntry[]>([])

  useEffect(() => {
    selectedTrackRef.current = selectedTrack
  }, [selectedTrack])
  useEffect(() => {
    routeTrackIdRef.current = selection.trackId
  }, [selection.trackId])
  useEffect(() => {
    queueSizeRef.current = queueRuns.length
  }, [queueRuns.length])

  const pushToast = useCallback(
    (tone: ToastTone, message: string, options?: { autoDismissMs?: number | null; action?: ToastAction }) => {
      const toast: Toast = {
        id: createId(),
        tone,
        message,
        createdAt: Date.now(),
        autoDismissMs:
          options?.autoDismissMs !== undefined
            ? options.autoDismissMs
            : tone === 'error'
              ? null
              : 4000,
        action: options?.action,
      }
      setToasts((current) => [...current, toast])
    },
    [],
  )

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  function formatTrackLabel(track: { title: string; artist: string | null }) {
    return track.artist ? `${track.title} · ${track.artist}` : track.title
  }

  function findTrackLabel(trackId: string) {
    const track = tracks.find((item) => item.id === trackId)
    return track ? formatTrackLabel(track) : 'this song'
  }

  function findRunTrackLabel(runId: string) {
    const queueEntry = queueRuns.find((entry) => entry.run.id === runId)
    if (queueEntry) {
      return queueEntry.track_artist
        ? `${queueEntry.track_title} · ${queueEntry.track_artist}`
        : queueEntry.track_title
    }

    if (selectedTrack?.runs.some((run) => run.id === runId)) return formatTrackLabel(selectedTrack)

    return 'this song'
  }

  const syncSelectedTrackDetail = useCallback(async (
    trackId: string | null,
    queueSize?: number,
  ) => {
    const requestId = ++selectedTrackRequestIdRef.current
    const nextQueueSize = queueSize ?? queueSizeRef.current

    if (!trackId) {
      setSelectedTrack(null)
      refreshIntervalMsRef.current = resolveRefreshInterval(null, nextQueueSize)
      return
    }

    if (selectedTrackRef.current?.id !== trackId) {
      setSelectedTrack(null)
    }

    const resolvedTrack = await loadTrackDetail(trackId)

    if (requestId !== selectedTrackRequestIdRef.current) return

    if (!resolvedTrack) {
      setSelectedTrack(null)
      refreshIntervalMsRef.current = resolveRefreshInterval(null, nextQueueSize)
      return
    }

    setSelectedTrack(resolvedTrack)
    refreshIntervalMsRef.current = resolveRefreshInterval(resolvedTrack, nextQueueSize)
  }, [])

  const refreshDashboard = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    lastPollAtRef.current = Date.now()

    try {
      const [nextDiagnostics, nextSettings, nextStorageOverview, nextTracks, nextDrafts, nextActiveRuns] = await Promise.all([
        getDiagnostics(),
        getSettings(),
        getStorageOverview(),
        getTracks(),
        listImportDrafts(),
        getActiveRuns(),
      ])
      const nextQueue = nextActiveRuns.runs
      // Detect stem creation completions/failures to surface a toast notification.
      const prevActive = prevQueueRunsRef.current.filter((e) => isActiveRunStatus(e.run.status))
      for (const entry of prevActive) {
        const stillActive = nextQueue.some((q) => q.run.id === entry.run.id && isActiveRunStatus(q.run.status))
        if (stillActive) continue
        const track = nextTracks.find((t) => t.id === entry.track_id)
        if (track?.latest_run?.id === entry.run.id) {
          if (track.latest_run.status === 'completed') {
            pushToast('success', `${entry.track_title} is ready to mix.`)
          } else if (track.latest_run.status === 'failed') {
            pushToast('error', `Stem creation failed for ${entry.track_title}.`)
          }
        }
      }
      prevQueueRunsRef.current = nextQueue

      setDiagnostics(nextDiagnostics)
      setSettings(nextSettings)
      setStorageOverview(nextStorageOverview)
      setTracks(nextTracks)
      setDrafts(nextDrafts)
      setQueueRuns(nextQueue)
      setWorkerOnline(nextActiveRuns.worker_online)

      await syncSelectedTrackDetail(routeTrackIdRef.current, nextQueue.length)

      setConnection({
        state: 'ready',
        consecutiveFailures: 0,
        lastSyncAt: Date.now(),
        nextRetryAt: null,
        lastError: null,
      })
    } catch (error) {
      const message = getErrorMessage(error)
      setConnection((current) => {
        const failures = current.consecutiveFailures + 1
        const backoff = Math.min(IDLE_REFRESH_MS * 2 ** failures, MAX_REFRESH_MS)
        refreshIntervalMsRef.current = backoff
        return {
          state: 'offline',
          consecutiveFailures: failures,
          lastSyncAt: current.lastSyncAt,
          nextRetryAt: Date.now() + backoff,
          lastError: message,
        }
      })
    } finally {
      inFlightRef.current = false
    }
  }, [pushToast, syncSelectedTrackDetail])

  useEffect(() => {
    let disposed = false

    const initialLoadId = window.setTimeout(() => {
      discardRejection(refreshDashboard)
    }, 0)

    function tick() {
      if (disposed) return
      if (document.hidden) return
      const sinceLast = Date.now() - lastPollAtRef.current
      if (sinceLast < refreshIntervalMsRef.current) return
      discardRejection(refreshDashboard)
    }

    const intervalId = window.setInterval(tick, 500)

    function handleVisibility() {
      if (!document.hidden) discardRejection(refreshDashboard)
    }

    function flushPendingDestructive() {
      const pendingIds = Array.from(pendingDeleteIdsRef.current)
      flushPendingTrackDeletes(pendingIds)
      if (pendingLibraryCleanupTimerRef.current !== null) {
        flushPendingLibraryCleanup()
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('beforeunload', flushPendingDestructive)

    return () => {
      disposed = true
      window.clearTimeout(initialLoadId)
      window.clearInterval(intervalId)
      clearTimer(pendingDeleteTimerRef)
      clearTimer(pendingLibraryCleanupTimerRef)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('beforeunload', flushPendingDestructive)
    }
  }, [refreshDashboard])

  useEffect(() => {
    const id = window.setTimeout(() => {
      discardRejection(() => syncSelectedTrackDetail(selection.trackId))
    }, 0)
    return () => window.clearTimeout(id)
  }, [selection.trackId, syncSelectedTrackDetail])

  // ----- Import (Add Sources) -----

  async function handleResolveYouTube(sourceUrl: string) {
    setResolvingYoutubeImport(true)
    try {
      const result = await resolveYouTubeImport(sourceUrl)
      const count = result.drafts.length
      pushToast(
        'success',
        `Staged ${count} source${count === 1 ? '' : 's'}. Review imports is the next step.`,
      )
      await refreshDashboard()
      return result
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setResolvingYoutubeImport(false)
    }
  }

  async function handleResolveLocalImport(files: File[]) {
    setResolvingLocalImport(true)
    try {
      const result = await resolveLocalImport(files)
      const count = result.drafts.length
      pushToast(
        'success',
        `Staged ${count} source${count === 1 ? '' : 's'}. Review imports is the next step.`,
      )
      await refreshDashboard()
      return result
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setResolvingLocalImport(false)
    }
  }

  // ----- Drafts -----

  async function handleUpdateDraft(draftId: string, payload: UpdateImportDraftInput) {
    try {
      await updateImportDraft(draftId, payload)
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    }
  }

  async function handleDiscardDraft(draftId: string) {
    try {
      await discardImportDraft(draftId)
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    }
  }

  async function handleConfirmDrafts(
    payload: ConfirmImportDraftsInput,
  ): Promise<ConfirmImportDraftsResponse> {
    if (!payload.draft_ids.length) {
      throw new Error('Choose at least one import before confirming.')
    }
    setConfirmingDrafts(true)
    try {
      const result = await confirmImportDrafts(payload)
      const createdMsg = result.created_track_count
        ? `${result.created_track_count} new track${result.created_track_count === 1 ? '' : 's'}`
        : ''
      const reusedMsg = result.reused_track_count
        ? `${result.reused_track_count} reused`
        : ''
      const queuedMsg = result.queued_run_count
        ? `${result.queued_run_count} stem set${result.queued_run_count === 1 ? '' : 's'} queued`
        : 'imported without queueing'
      const parts = [createdMsg, reusedMsg, queuedMsg].filter(Boolean)
      pushToast('success', `Imported: ${parts.join(' · ')}.`)
      await refreshDashboard()
      return result
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setConfirmingDrafts(false)
    }
  }

  // ----- Runs -----

  async function handleCreateRun(
    trackId: string,
    processing: RunProcessingConfigInput,
  ): Promise<RunMutationResponse> {
    setCreatingRun(true)
    try {
      const result = await createRun(trackId, processing)
      pushToast('success', describeCreateRunToast(findTrackLabel(trackId), result))
      await refreshDashboard()
      return result
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setCreatingRun(false)
    }
  }

  async function handleBatchCreateRun(
    trackIds: string[],
    processing: RunProcessingConfigInput,
  ) {
    if (!trackIds.length) return
    setCreatingRun(true)
    try {
      const results = await Promise.allSettled(
        trackIds.map((id) => createRun(id, processing)),
      )
      const feedback = describeBatchCreateRunToast(results)
      pushToast(feedback.tone, feedback.message)
      await refreshDashboard()
    } finally {
      setCreatingRun(false)
    }
  }

  async function handleCancelRun(runId: string) {
    setCancellingRunId(runId)
    try {
      await cancelRun(runId)
      pushToast('success', `Cancellation requested for ${findRunTrackLabel(runId)}.`)
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setCancellingRunId(null)
    }
  }

  async function handleRevealFolder(payload: RevealFolderInput) {
    try {
      await revealFolder(payload)
    } catch (error) {
      pushToast('error', getErrorMessage(error))
    }
  }

  async function handleRetryRun(runId: string): Promise<RunMutationResponse> {
    setRetryingRunId(runId)
    try {
      const result = await retryRun(runId)
      pushToast('success', describeRetryRunToast(findRunTrackLabel(runId), result))
      await refreshDashboard()
      return result
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setRetryingRunId(null)
    }
  }

  async function handleDismissRun(runId: string) {
    setDismissingRunId(runId)
    try {
      await dismissRun(runId)
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setDismissingRunId(null)
    }
  }

  async function handleDeleteRun(runId: string) {
    setDeletingRunId(runId)
    try {
      await deleteRun(runId)
      pushToast('success', 'Deleted stem set.')
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setDeletingRunId(null)
    }
  }

  async function handleSetKeeper(trackId: string, runId: string | null) {
    setSettingKeeper(true)
    try {
      await setKeeperRun(trackId, runId)
      pushToast('success', runId ? 'Marked as preferred stem set.' : 'Cleared preferred stem set.')
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setSettingKeeper(false)
    }
  }

  async function handleBackfillMetrics() {
    setBackfillingMetrics(true)
    try {
      const result = await backfillMetrics()
      pushToast(
        'success',
        `Backfilled metrics for ${result.updated_artifact_count} artifact${result.updated_artifact_count === 1 ? '' : 's'}.`,
      )
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setBackfillingMetrics(false)
    }
  }

  async function handleUpdateTrack(trackId: string, payload: { title?: string; artist?: string | null }) {
    setUpdatingTrack(true)
    try {
      await updateTrack(trackId, payload)
      pushToast('success', 'Track updated.')
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setUpdatingTrack(false)
    }
  }

  function handleDeleteTrack(trackId: string) {
    scheduleTrackDelete([trackId])
  }

  function handleBatchDeleteTracks(trackIds: string[]) {
    scheduleTrackDelete(trackIds)
  }

  async function handleSaveMix(trackId: string, runId: string, stems: RunMixStemEntry[]) {
    setSavingMixRunId(runId)
    try {
      await updateRunMix(trackId, runId, stems)
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setSavingMixRunId(null)
    }
  }

  function setPendingDeleteIdsImmediate(next: Set<string>) {
    pendingDeleteIdsRef.current = next
    setPendingDeleteIds(next)
  }

  function removePendingDeleteIds(trackIds: string[]) {
    if (!trackIds.length) return

    const next = new Set(pendingDeleteIdsRef.current)
    let changed = false
    for (const id of trackIds) {
      if (!next.delete(id)) continue
      changed = true
    }
    if (!changed) return
    setPendingDeleteIdsImmediate(next)
  }

  async function commitTrackDelete(trackIds: string[]) {
    if (!trackIds.length) return
    try {
      const result = await batchDeleteTracks({ track_ids: trackIds })
      removePendingDeleteIds(trackIds)
      const feedback = describeBatchDeleteResult(result)
      pushToast(feedback.tone, feedback.message)
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      removePendingDeleteIds(trackIds)
    }
  }

  function restorePendingDelete(ids: string[]) {
    if (pendingDeleteTimerRef.current === null) return
    const current = pendingDeleteIdsRef.current
    if (ids.length !== current.size || !ids.every((id) => current.has(id))) return
    clearTimer(pendingDeleteTimerRef)
    setPendingDeleteIdsImmediate(new Set())
  }

  function scheduleTrackDelete(trackIds: string[]) {
    if (!trackIds.length) return
    if (pendingDeleteTimerRef.current !== null) {
      const previous = Array.from(pendingDeleteIdsRef.current)
      clearTimer(pendingDeleteTimerRef)
      if (previous.length) {
        discardRejection(() => commitTrackDelete(previous))
      }
    }
    const scheduled = [...trackIds]
    setPendingDeleteIdsImmediate(new Set(scheduled))
    pushToast(
      'info',
      `Scheduled ${scheduled.length} track${scheduled.length === 1 ? '' : 's'} for deletion.`,
      {
        autoDismissMs: DELETE_UNDO_MS,
        action: {
          label: 'Undo',
          onInvoke: () => restorePendingDelete(scheduled),
        },
      },
    )
    pendingDeleteTimerRef.current = window.setTimeout(() => {
      pendingDeleteTimerRef.current = null
      discardRejection(() => commitTrackDelete(scheduled))
    }, DELETE_UNDO_MS)
  }

  async function handleSaveSettings(payload: Omit<Settings, 'stem_options' | 'quality_options'>) {
    setSavingSettings(true)
    try {
      await updateSettings(payload)
      pushToast('success', 'Settings saved.')
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setSavingSettings(false)
    }
  }

  function formatReclaimed(bytes: number) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  async function handleCleanupTempStorage() {
    setCleaningTempStorage(true)
    try {
      const result: TempCleanupResponse = await cleanupTempStorage()
      pushToast(
        'success',
        `Cleared ${result.deleted_entry_count} temp item${result.deleted_entry_count === 1 ? '' : 's'} · ${formatReclaimed(result.bytes_reclaimed)} reclaimed.`,
      )
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setCleaningTempStorage(false)
    }
  }

  async function handleCleanupExportBundles() {
    setCleaningExportBundles(true)
    try {
      const result: ExportBundleCleanupResponse = await cleanupExportBundles()
      pushToast(
        'success',
        `Deleted ${result.deleted_bundle_count} export download${result.deleted_bundle_count === 1 ? '' : 's'} · ${formatReclaimed(result.bytes_reclaimed)} reclaimed.`,
      )
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setCleaningExportBundles(false)
    }
  }

  async function commitLibraryCleanup() {
    try {
      const result: NonKeeperCleanupResponse = await cleanupNonKeeperRunsLibrary()
      const skipped =
        result.skipped_track_count > 0
          ? ` · ${result.skipped_track_count} track${result.skipped_track_count === 1 ? '' : 's'} skipped`
          : ''
      pushToast(
        'success',
        `Purged ${result.deleted_run_count} non-preferred stem set${result.deleted_run_count === 1 ? '' : 's'} across ${result.purged_track_count} track${result.purged_track_count === 1 ? '' : 's'} · ${formatReclaimed(result.bytes_reclaimed)} reclaimed${skipped}.`,
      )
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
    } finally {
      setCleaningLibraryRuns(false)
    }
  }

  function restorePendingLibraryCleanup() {
    if (pendingLibraryCleanupTimerRef.current === null) return
    clearTimer(pendingLibraryCleanupTimerRef)
    setCleaningLibraryRuns(false)
  }

  async function handleResetLibrary() {
    setResettingLibrary(true)
    try {
      const result: LibraryResetResponse = await resetLibrary()
      pushToast(
        'success',
        `Cleared ${result.deleted_track_count} song${result.deleted_track_count === 1 ? '' : 's'} · ${formatReclaimed(result.bytes_reclaimed)} reclaimed.`,
      )
      await refreshDashboard()
    } catch (error) {
      pushToast('error', getErrorMessage(error))
      throw error
    } finally {
      setResettingLibrary(false)
    }
  }

  function handleCleanupLibraryRuns() {
    if (pendingLibraryCleanupTimerRef.current !== null) {
      clearTimer(pendingLibraryCleanupTimerRef)
      discardRejection(commitLibraryCleanup)
      return
    }
    setCleaningLibraryRuns(true)
    pushToast(
      'info',
      'Scheduled non-preferred stem set cleanup across the library.',
      {
        autoDismissMs: PURGE_UNDO_MS,
        action: {
          label: 'Undo',
          onInvoke: () => restorePendingLibraryCleanup(),
        },
      },
    )
    pendingLibraryCleanupTimerRef.current = window.setTimeout(() => {
      pendingLibraryCleanupTimerRef.current = null
      discardRejection(commitLibraryCleanup)
    }, PURGE_UNDO_MS)
  }

  const visibleTracks = useMemo(
    () => (pendingDeleteIds.size ? tracks.filter((track) => !pendingDeleteIds.has(track.id)) : tracks),
    [tracks, pendingDeleteIds],
  )

  return {
    diagnostics,
    settings,
    storageOverview,
    tracks: visibleTracks,
    drafts,
    queueRuns,
    workerOnline,
    selectedTrack,
    toasts,
    dismissToast,
    pushToast,
    connection,
    resolvingYoutubeImport,
    resolvingLocalImport,
    confirmingDrafts,
    creatingRun,
    cancellingRunId,
    retryingRunId,
    dismissingRunId,
    deletingRunId,
    savingSettings,
    cleaningTempStorage,
    cleaningExportBundles,
    cleaningLibraryRuns,
    resettingLibrary,
    settingKeeper,
    backfillingMetrics,
    savingMixRunId,
    updatingTrack,
    handleResolveYouTube,
    handleResolveLocalImport,
    handleUpdateDraft,
    handleDiscardDraft,
    handleConfirmDrafts,
    handleCreateRun,
    handleBatchCreateRun,
    handleCancelRun,
    handleRetryRun,
    handleDismissRun,
    handleDeleteRun,
    handleRevealFolder,
    handleSaveSettings,
    handleCleanupTempStorage,
    handleCleanupExportBundles,
    handleCleanupLibraryRuns,
    handleResetLibrary,
    handleSetKeeper,
    handleBackfillMetrics,
    handleSaveMix,
    handleUpdateTrack,
    handleDeleteTrack,
    handleBatchDeleteTracks,
  }
}
