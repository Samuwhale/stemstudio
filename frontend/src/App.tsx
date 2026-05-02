import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate } from 'react-router-dom'

import './App.css'
import './redesign.css'
import { discardRejection } from './async'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ImportPanel } from './components/imports/ImportPanel'
import { BatchExportOverlay } from './components/export/BatchExportOverlay'
import { SettingsDrawer } from './components/SettingsDrawer'
import { ToastStack } from './components/feedback/ToastStack'
import { BatchStemOverlay } from './components/mix/BatchStemOverlay'
import { MixWorkspace } from './components/mix/MixWorkspace'
import { SongsPage } from './components/songs/SongsPage'
import { applySongBrowse } from './components/trackListView'
import { useDashboardData } from './hooks/useDashboardData'
import type { Connection } from './hooks/useDashboardData'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { filterImportableMediaFiles } from './importableMedia'
import { buildMixPath, buildSongsPath, parseSongsView } from './routes'
import type { SongsView } from './routes'
import { resolveSelectedRun, resolveVisibleRunAtIndex } from './runSelection'
import type { RunProcessingConfigInput, TrackSummary } from './types'

type NavigationState = {
  songsView?: SongsView
  currentTrackId?: string | null
}

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const mixMatch = useMatch('/mix/:trackId')
  const mixActive = !!mixMatch
  const mixTrackId = mixMatch?.params.trackId ?? null
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search])
  const mixRunId = mixActive ? searchParams.get('run') : null
  const routeSongsView = useMemo(() => parseSongsView(new URLSearchParams(location.search)), [location.search])
  const navigationState = location.state as NavigationState | null
  const rememberedSongsView = navigationState?.songsView ?? parseSongsView(new URLSearchParams())
  const rememberedCurrentTrackId = navigationState?.currentTrackId ?? mixTrackId ?? null
  const songsView = !mixActive ? routeSongsView : rememberedSongsView

  const dashboard = useDashboardData({ trackId: mixTrackId })
  const {
    diagnostics,
    settings,
    storageOverview,
    tracks,
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
  } = dashboard

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme')
    if (saved === 'dark') return 'dark'
    if (saved === 'light') return 'light'
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('theme', theme)
  }, [theme])

  function toggleTheme() {
    document.documentElement.classList.add('theme-transitioning')
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
    window.setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 300)
  }

  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsView, setSettingsView] = useState<'preferences' | 'maintenance' | 'storage'>(
    'preferences',
  )
  const [importPanelOpen, setImportPanelOpen] = useState(false)
  const [batchExportIds, setBatchExportIds] = useState<string[] | null>(null)
  const [batchStemIds, setBatchStemIds] = useState<string[] | null>(null)
  const [dragOverlayActive, setDragOverlayActive] = useState(false)
  const anyDialogOpen = settingsOpen || importPanelOpen || !!batchExportIds || !!batchStemIds || shortcutsOpen
  const dragCounterRef = useRef(0)

  const browseTracks = useMemo(
    () =>
      applySongBrowse(tracks, {
        search: songsView.search,
        sort: songsView.sort,
        filter: songsView.filter,
      }),
    [songsView.filter, songsView.search, songsView.sort, tracks],
  )
  const currentBrowseIndex = useMemo(
    () => (mixActive && mixTrackId ? browseTracks.findIndex((t) => t.id === mixTrackId) : -1),
    [mixActive, mixTrackId, browseTracks],
  )
  const hasPrevTrack = currentBrowseIndex > 0
  const hasNextTrack = currentBrowseIndex >= 0 && currentBrowseIndex < browseTracks.length - 1
  const trackPosition = currentBrowseIndex >= 0 && browseTracks.length > 0
    ? { index: currentBrowseIndex, total: browseTracks.length }
    : null
  const defaultProcessing: RunProcessingConfigInput = useMemo(
    () => ({
      stems: settings?.default_stem_selection.stems ?? ['instrumental', 'vocals'],
      quality: settings?.default_stem_selection.quality ?? 'balanced',
    }),
    [settings?.default_stem_selection.quality, settings?.default_stem_selection.stems],
  )
  const defaultBitrate = settings?.export_mp3_bitrate ?? '320k'
  const hasFirstSync = connection.lastSyncAt > 0
  const setupRequired = hasFirstSync && diagnostics ? !diagnostics.app_ready : false

  function openSettings(view: 'preferences' | 'maintenance' | 'storage') {
    setSettingsView(view)
    setSettingsOpen(true)
  }

  function openSongs(view = rememberedSongsView, currentTrackId = rememberedCurrentTrackId) {
    navigate(buildSongsPath(view), { state: { songsView: view, currentTrackId } })
  }

  function openMix(trackId: string, options?: { runId?: string | null }) {
    navigate(buildMixPath(trackId, { runId: options?.runId ?? null }), {
      state: { songsView, currentTrackId: trackId },
    })
  }

  function openTrackWorkspace(track: TrackSummary, options?: { runId?: string | null }) {
    const runId = options?.runId ?? track.keeper_run_id ?? track.latest_run?.id ?? null
    openMix(track.id, { runId })
  }

  function revealImportPanel() {
    if (mixActive) openSongs()
    setImportPanelOpen(true)
  }

  useEffect(() => {
    if (!mixActive) return
    const trackKnown = mixTrackId ? tracks.some((track) => track.id === mixTrackId) : false
    if (hasFirstSync && !selectedTrack && !trackKnown) {
      navigate(buildSongsPath(songsView), {
        replace: true,
        state: { songsView, currentTrackId: null },
      })
      return
    }
    if (!selectedTrack) return

    const resolvedRun = resolveSelectedRun(selectedTrack, mixRunId)
    const nextPath = buildMixPath(selectedTrack.id, {
      runId: resolvedRun?.id ?? null,
    })

    if (`${location.pathname}${location.search}` !== nextPath) {
      navigate(nextPath, {
        replace: true,
        state: { songsView, currentTrackId: selectedTrack.id },
      })
    }
  }, [
    hasFirstSync,
    location.pathname,
    location.search,
    mixActive,
    mixRunId,
    mixTrackId,
    navigate,
    selectedTrack,
    songsView,
    tracks,
  ])

  useEffect(() => {
    if (importPanelOpen) return

    function hasFiles(event: DragEvent) {
      return Array.from(event.dataTransfer?.types ?? []).includes('Files')
    }

    function onDragEnter(event: DragEvent) {
      if (!hasFiles(event)) return
      dragCounterRef.current += 1
      if (dragCounterRef.current === 1) setDragOverlayActive(true)
    }

    function onDragLeave(event: DragEvent) {
      if (!hasFiles(event)) return
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
      if (dragCounterRef.current === 0) setDragOverlayActive(false)
    }

    function onDragOver(event: DragEvent) {
      if (!hasFiles(event)) return
      event.preventDefault()
    }

    function onDrop(event: DragEvent) {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragCounterRef.current = 0
      setDragOverlayActive(false)
      const files = filterImportableMediaFiles(event.dataTransfer?.files ?? [])
      if (files.length) {
        discardRejection(async () => {
          await handleResolveLocalImport(files)
          if (mixActive) {
            navigate(buildSongsPath(rememberedSongsView), {
              state: { songsView: rememberedSongsView, currentTrackId: rememberedCurrentTrackId },
            })
          }
          setImportPanelOpen(true)
        })
        return
      }
      pushToast('error', 'Drop audio or video files to import them.')
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
      dragCounterRef.current = 0
      setDragOverlayActive(false)
    }
  }, [handleResolveLocalImport, importPanelOpen, mixActive, navigate, pushToast, rememberedCurrentTrackId, rememberedSongsView])

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }

      const text = event.clipboardData?.getData('text/plain').trim() ?? ''
      if (!text || !/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\b/i.test(text)) return
      event.preventDefault()
      discardRejection(async () => {
        await handleResolveYouTube(text)
        if (mixActive) {
          navigate(buildSongsPath(rememberedSongsView), {
            state: { songsView: rememberedSongsView, currentTrackId: rememberedCurrentTrackId },
          })
        }
        setImportPanelOpen(true)
      })
    }

    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [handleResolveYouTube, mixActive, navigate, rememberedCurrentTrackId, rememberedSongsView])

  function selectAdjacentTrack(offset: number) {
    if (!browseTracks.length) return
    const currentIndex = mixTrackId ? browseTracks.findIndex((track) => track.id === mixTrackId) : -1
    const nextIndex =
      currentIndex < 0 ? 0 : Math.max(0, Math.min(browseTracks.length - 1, currentIndex + offset))
    const nextTrack = browseTracks[nextIndex]
    if (!nextTrack) return
    openTrackWorkspace(nextTrack)
  }

  useKeyboardShortcuts({
    onNavigateNext: () => selectAdjacentTrack(1),
    onNavigatePrev: () => selectAdjacentTrack(-1),
    onAddSongs: () => {
      if (anyDialogOpen) return
      revealImportPanel()
    },
    onRerun: () => {
      if (!mixActive || !selectedTrack || creatingRun) return
      discardRejection(() => handleCreateRun(selectedTrack.id, defaultProcessing))
    },
    onSelectRunByIndex: (index) => {
      if (!mixActive || !selectedTrack) return
      const run = resolveVisibleRunAtIndex(selectedTrack, index)
      if (!run) return
      openMix(selectedTrack.id, { runId: run.id })
    },
    onToggleSettings: () => {
      if (settingsOpen) setSettingsOpen(false)
      else openSettings('preferences')
    },
    onToggleShortcuts: () => setShortcutsOpen((open) => !open),
    onEscape: () => {
      if (shortcutsOpen) { setShortcutsOpen(false); return }
      if (settingsOpen) { setSettingsOpen(false); return }
      if (importPanelOpen) { setImportPanelOpen(false); return }
      if (batchExportIds) { setBatchExportIds(null); return }
      if (batchStemIds) setBatchStemIds(null)
    },
  })

  return (
    <ErrorBoundary>
      <div className="shell">
        {!mixActive ? (
          <header className="app-top" inert={anyDialogOpen || undefined}>
            <button
              type="button"
              className="app-top-brand"
              onClick={() => openSongs({ ...songsView, search: '', filter: 'all' })}
              aria-label="Go to library"
            >
              Stems
            </button>
            <div className="app-top-actions">
              {setupRequired ? (
                <button
                  type="button"
                  className="topbar-chip topbar-chip-warn"
                  onClick={() => openSettings('maintenance')}
                >
                  <span className="topbar-dot topbar-dot-warn" />
                  finish setup
                </button>
              ) : null}
              {!workerOnline ? (
                <button
                  type="button"
                  className="topbar-chip topbar-chip-warn"
                  title="Splits won't process until the worker restarts. Run `npm run dev:worker` in your terminal."
                  onClick={() =>
                    pushToast(
                      'error',
                      "Worker is offline. Run `npm run dev:worker` (or restart `npm run dev`) to resume splits.",
                    )
                  }
                >
                  <span className="topbar-dot topbar-dot-warn" />
                  worker offline
                </button>
              ) : null}
              <ConnectionDot connection={connection} hasFirstSync={hasFirstSync} />
              <button
                type="button"
                className="icon-button"
                onClick={() => setShortcutsOpen(true)}
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts (?)"
              >
                <QuestionIcon />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
              >
                {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => openSettings('preferences')}
                aria-label="Settings"
                title="Settings"
              >
                <GearIcon />
              </button>
              <button type="button" className="button-primary" title="Add songs (a)" onClick={revealImportPanel}>
                Add songs
              </button>
            </div>
          </header>
        ) : null}

        <main
          className={mixActive ? 'shell-mix-main' : 'shell-library-main'}
          inert={anyDialogOpen || undefined}
        >
          <Routes>
            <Route path="/" element={<Navigate to="/songs" replace />} />
            <Route
              path="/songs"
              element={
                <SongsPage
                  view={songsView}
                  tracks={tracks}
                  currentTrackId={rememberedCurrentTrackId}
                  stagedImportsCount={drafts.length}
                  queueRuns={queueRuns}
                  cancellingRunId={cancellingRunId}
                  retryingRunId={retryingRunId}
                  dismissingRunId={dismissingRunId}
                  onViewChange={(next) =>
                    navigate(buildSongsPath(next), {
                      state: { songsView: next, currentTrackId: rememberedCurrentTrackId },
                    })
                  }
                  onOpenTrack={openTrackWorkspace}
                  onAddSongs={revealImportPanel}
                  onReviewImports={revealImportPanel}
                  onCancelRun={handleCancelRun}
                  onRetryRun={handleRetryRun}
                  onDismissRun={handleDismissRun}
                  onBatchCreateStems={(ids) => setBatchStemIds(ids)}
                  onBatchExport={(ids) => setBatchExportIds(ids)}
                  onBatchDelete={handleBatchDeleteTracks}
                />
              }
            />
            <Route
              path="/mix/:trackId"
              element={
                <MixWorkspace
                  track={selectedTrack}
                  selectedRunId={mixRunId}
                  stemOptions={settings?.stem_options ?? []}
                  qualityOptions={settings?.quality_options ?? []}
                  defaultSelection={defaultProcessing}
                  defaultBitrate={defaultBitrate}
                  creatingRun={creatingRun}
                  cancellingRunId={cancellingRunId}
                  retryingRunId={retryingRunId}
                  deletingRunId={deletingRunId}
                  settingKeeper={settingKeeper}
                  savingMixRunId={savingMixRunId}
                  updatingTrack={updatingTrack}
                  hasPrevTrack={hasPrevTrack}
                  hasNextTrack={hasNextTrack}
                  trackPosition={trackPosition}
                  onBackToSongs={() => openSongs()}
                  onNavigatePrev={() => selectAdjacentTrack(-1)}
                  onNavigateNext={() => selectAdjacentTrack(1)}
                  onSelectRun={(runId) => {
                    if (!selectedTrack) return
                    openMix(selectedTrack.id, { runId })
                  }}
                  onCreateRun={handleCreateRun}
                  onCancelRun={handleCancelRun}
                  onRetryRun={handleRetryRun}
                  onDeleteRun={handleDeleteRun}
                  onSetKeeper={handleSetKeeper}
                  onSaveMix={handleSaveMix}
                  onUpdateTrack={handleUpdateTrack}
                  onDeleteTrack={(trackId) => {
                    handleDeleteTrack(trackId)
                    openSongs(undefined, null)
                  }}
                  onReveal={handleRevealFolder}
                  onOpenShortcuts={() => setShortcutsOpen(true)}
                  onError={(message) => pushToast('error', message)}
                />
              }
            />
            <Route path="*" element={<Navigate to="/songs" replace />} />
          </Routes>
        </main>

        <SettingsDrawer
          open={settingsOpen}
          initialView={settingsView}
          diagnostics={diagnostics}
          settings={settings}
          storageOverview={storageOverview}
          savingSettings={savingSettings}
          cleaningTempStorage={cleaningTempStorage}
          cleaningExportBundles={cleaningExportBundles}
          cleaningLibraryRuns={cleaningLibraryRuns}
          resettingLibrary={resettingLibrary}
          backfillingMetrics={backfillingMetrics}
          onClose={() => setSettingsOpen(false)}
          onSaveSettings={handleSaveSettings}
          onCleanupTempStorage={handleCleanupTempStorage}
          onCleanupExportBundles={handleCleanupExportBundles}
          onCleanupLibraryRuns={handleCleanupLibraryRuns}
          onResetLibrary={handleResetLibrary}
          onBackfillMetrics={handleBackfillMetrics}
        />

        <ImportPanel
          open={importPanelOpen}
          drafts={drafts}
          stemOptions={settings?.stem_options ?? []}
          qualityOptions={settings?.quality_options ?? []}
          defaultSelection={defaultProcessing}
          resolvingYoutubeImport={resolvingYoutubeImport}
          resolvingLocalImport={resolvingLocalImport}
          confirming={confirmingDrafts}
          onClose={() => setImportPanelOpen(false)}
          onResolveYouTube={handleResolveYouTube}
          onResolveLocalImport={handleResolveLocalImport}
          onUpdateDraft={handleUpdateDraft}
          onDiscardDraft={handleDiscardDraft}
          onConfirm={async (payload) => {
            const result = await handleConfirmDrafts(payload)
            setImportPanelOpen(false)
            if (payload.queue && result.tracks.length === 1 && result.queued_run_count === 1) {
              const track = result.tracks[0]
              openMix(track.id, { runId: track.latest_run?.id ?? null })
            }
            return result
          }}
        />

        <BatchExportOverlay
          open={!!batchExportIds}
          tracks={tracks}
          selectedTrackIds={batchExportIds ?? []}
          defaultBitrate={defaultBitrate}
          onClose={() => setBatchExportIds(null)}
          onReveal={handleRevealFolder}
          onError={(message) => pushToast('error', message)}
        />

        <BatchStemOverlay
          open={!!batchStemIds}
          tracks={tracks}
          selectedTrackIds={batchStemIds ?? []}
          stemOptions={settings?.stem_options ?? []}
          qualityOptions={settings?.quality_options ?? []}
          defaultSelection={defaultProcessing}
          busy={creatingRun}
          onClose={() => setBatchStemIds(null)}
          onConfirm={async (ids, processing) => {
            await handleBatchCreateRun(ids, processing)
            setBatchStemIds(null)
          }}
        />

        {shortcutsOpen ? <KeyboardShortcutsModal onClose={() => setShortcutsOpen(false)} /> : null}

        <ToastStack toasts={toasts} onDismiss={dismissToast} />

        {dragOverlayActive ? (
          <div className="drop-overlay" role="presentation">
            <div className="drop-overlay-panel" role="status" aria-live="polite">
              <strong>Drop to import</strong>
              <span>Audio or video files only.</span>
            </div>
          </div>
        ) : null}
      </div>
    </ErrorBoundary>
  )
}

type ShortcutEntry = { key: string; desc: string; note?: string }
type ShortcutGroup = { section: string; entries: ShortcutEntry[] }

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    section: 'Anywhere',
    entries: [
      { key: 'a', desc: 'Add songs' },
      { key: 'j / ↓', desc: 'Next track' },
      { key: 'k / ↑', desc: 'Previous track' },
      { key: '?', desc: 'Show shortcuts' },
      { key: '⌘ ,', desc: 'Open settings' },
      { key: 'Esc', desc: 'Close panel / clear selection' },
    ],
  },
  {
    section: 'Mix workspace',
    entries: [
      { key: 'Space', desc: 'Play / Pause' },
      { key: 'r', desc: 'Create default stems again' },
      { key: '1 – 9', desc: 'Switch stem set by index' },
      { key: 'v', desc: 'Open stem picker' },
      { key: 'e', desc: 'Open export panel' },
      { key: '← →', desc: 'Adjust fader', note: '0.5 dB' },
      { key: 'Shift + ← →', desc: 'Fine fader', note: '0.1 dB' },
      { key: 'Alt + ← →', desc: 'Coarse fader', note: '3 dB' },
      { key: 'double-click fader', desc: 'Reset to 0 dB' },
    ],
  },
]

function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="kbd-backdrop"
      role="dialog"
      aria-modal
      aria-label="Keyboard shortcuts"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="kbd-panel">
        <div className="kbd-head">
          <strong>Keyboard shortcuts</strong>
          <button type="button" className="button-secondary" onClick={onClose}>Done</button>
        </div>
        <div className="kbd-groups">
          {SHORTCUT_GROUPS.map(({ section, entries }) => (
            <div key={section} className="kbd-group">
              <div className="kbd-group-head">{section}</div>
              <ul className="kbd-list">
                {entries.map(({ key, desc, note }, i) => (
                  <li key={i} className="kbd-row">
                    <kbd className="kbd-key">{key}</kbd>
                    <span className="kbd-desc">{desc}</span>
                    {note ? <span className="kbd-note">{note}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ConnectionDot({ connection, hasFirstSync }: { connection: Connection; hasFirstSync: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (connection.state !== 'offline') return undefined
    const syncNow = () => setNow(Date.now())
    const timeoutId = window.setTimeout(syncNow, 0)
    const intervalId = window.setInterval(syncNow, 1000)
    return () => {
      window.clearTimeout(timeoutId)
      window.clearInterval(intervalId)
    }
  }, [connection.state])

  if (connection.state === 'offline') {
    const retryInMs = connection.nextRetryAt ? connection.nextRetryAt - now : 0
    const retryIn = Math.max(0, Math.ceil(retryInMs / 1000))
    return (
      <span className="topbar-chip" title={connection.lastError ?? 'Connection error'}>
        <span className="topbar-dot topbar-dot-offline" />
        offline · retry {retryIn}s
      </span>
    )
  }
  if (!hasFirstSync) {
    return (
      <span className="topbar-chip">
        <span className="topbar-dot topbar-dot-syncing" />
        loading
      </span>
    )
  }
  return null
}

function QuestionIcon() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M6.5 6.2c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5c0 .7-.4 1.2-1 1.5-.4.2-.5.5-.5.8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="8" cy="11" r=".75" fill="currentColor" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M13.2 9.6a5.4 5.4 0 0 0 0-3.2l1.3-1-1.3-2.3-1.6.5a5.4 5.4 0 0 0-2.8-1.6L8.5.5h-1L7 2a5.4 5.4 0 0 0-2.8 1.6L2.6 3l-1.3 2.3 1.3 1a5.4 5.4 0 0 0 0 3.2l-1.3 1 1.3 2.3 1.6-.5a5.4 5.4 0 0 0 2.8 1.6l.3 1.6h1l.3-1.6a5.4 5.4 0 0 0 2.8-1.6l1.6.5 1.3-2.3-1.3-1Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M12.95 3.05l-1.06 1.06M4.11 11.89l-1.06 1.06"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default App
