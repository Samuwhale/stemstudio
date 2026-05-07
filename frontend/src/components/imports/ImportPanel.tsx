import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import type { DragEvent } from 'react'

import { discardRejection } from '../../async'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useProcessingSelection } from '../../hooks/useProcessingSelection'
import { filterImportableMediaFiles } from '../../importableMedia'
import { stemSelectionLabel } from '../../stems'
import { StemSelectionPicker } from '../StemSelectionPicker'
import { formatDuration, formatSize } from '../metrics'
import { Spinner } from '../feedback/Spinner'
import type {
  ConfirmImportDraftsResponse,
  ConfirmImportDraftsInput,
  DraftDuplicateAction,
  ExistingTrackDuplicate,
  ImportDraft,
  QualityOption,
  ResolveLocalImportResponse,
  ResolveYouTubeImportResponse,
  RunProcessingConfigInput,
  StemOption,
  UpdateImportDraftInput,
} from '../../types'

type ImportPanelProps = {
  open: boolean
  drafts: ImportDraft[]
  stemOptions: StemOption[]
  qualityOptions: QualityOption[]
  defaultSelection: RunProcessingConfigInput
  resolvingYoutubeImport: boolean
  resolvingLocalImport: boolean
  confirming: boolean
  onClose: () => void
  onResolveYouTube: (url: string) => Promise<ResolveYouTubeImportResponse>
  onResolveLocalImport: (files: File[]) => Promise<ResolveLocalImportResponse>
  onUpdateDraft: (draftId: string, payload: UpdateImportDraftInput) => Promise<void>
  onDiscardDraft: (draftId: string) => Promise<void>
  onConfirm: (payload: ConfirmImportDraftsInput) => Promise<ConfirmImportDraftsResponse>
}

// ---- Icons -----------------------------------------------------------------

function UploadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden className="import-drop-icon">
      <path d="M10 13V4M7 7l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 14v1a2 2 0 002 2h10a2 2 0 002-2v-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden className="import-drop-icon import-drop-icon-ok">
      <path d="M5 10l4 4 6-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ---- Helpers ---------------------------------------------------------------

function sourceLabel(item: ImportDraft) {
  if (item.source_type === 'youtube') return item.playlist_source_url ? 'YouTube playlist' : 'YouTube'
  return item.original_filename ?? 'Local file'
}

function looksLikePlaylist(url: string) {
  return /[?&]list=/.test(url.trim())
}

function needsDuplicateDecision(item: ImportDraft) {
  if (item.duplicate_tracks.length === 0) return false
  if (item.duplicate_action === null) return true
  return (
    item.duplicate_action === 'reuse-existing' &&
    item.duplicate_tracks.length > 1 &&
    !item.existing_track_id
  )
}

function countAction(items: ImportDraft[], action: DraftDuplicateAction) {
  return items.filter((item) => item.duplicate_action === action).length
}

// ---- ImportRow -------------------------------------------------------------

type ImportRowProps = {
  draft: ImportDraft
  busy: boolean
  onUpdate: (payload: UpdateImportDraftInput) => Promise<void>
  onDiscard: () => void
}

type ImportRowHandle = {
  flushPendingEdits: () => Promise<void>
}

const ImportRow = forwardRef<ImportRowHandle, ImportRowProps>(function ImportRow(
  { draft, busy, onUpdate, onDiscard }: ImportRowProps,
  ref,
) {
  const [title, setTitle] = useState<string | null>(null)
  const [artist, setArtist] = useState<string | null>(null)
  const flushPromiseRef = useRef<Promise<void> | null>(null)
  const needsDecision = needsDuplicateDecision(draft)

  function buildPendingPatch(): UpdateImportDraftInput | null {
    const patch: UpdateImportDraftInput = {}

    if (title !== null) {
      const nextTitle = title.trim() || draft.suggested_title
      if (nextTitle !== draft.title.trim()) {
        patch.title = nextTitle
      }
    }

    if (artist !== null) {
      const nextArtist = artist.trim() || null
      if (nextArtist !== (draft.artist?.trim() || null)) {
        patch.artist = nextArtist
      }
    }

    return Object.keys(patch).length > 0 ? patch : null
  }

  async function flushPendingEdits() {
    if (flushPromiseRef.current) {
      await flushPromiseRef.current
      return
    }

    const promise = (async () => {
      const patch = buildPendingPatch()
      if (!patch) {
        setTitle(null)
        setArtist(null)
        return
      }
      await onUpdate(patch)
      setTitle(null)
      setArtist(null)
    })()

    flushPromiseRef.current = promise
    try {
      await promise
    } finally {
      flushPromiseRef.current = null
    }
  }

  useImperativeHandle(ref, () => ({ flushPendingEdits }))

  return (
    <article className={`import-row ${needsDecision ? 'needs-decision' : ''}`} aria-busy={busy}>
      <div className="import-row-head">
        <div className="import-row-title">
          <strong>{draft.title || 'Untitled'}</strong>
          <span>
            {[sourceLabel(draft), formatDuration(draft.duration_seconds), formatSize(draft.size_bytes)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <button type="button" className="import-row-remove" disabled={busy} onClick={onDiscard}>
          Remove
        </button>
      </div>

      <div className="import-row-fields">
        <label className="visually-hidden" htmlFor={`import-title-${draft.id}`}>Title</label>
        <input
          id={`import-title-${draft.id}`}
          type="text"
          value={title ?? draft.title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => discardRejection(flushPendingEdits)}
          placeholder="Title"
          disabled={busy}
        />
        <label className="visually-hidden" htmlFor={`import-artist-${draft.id}`}>Artist</label>
        <input
          id={`import-artist-${draft.id}`}
          type="text"
          value={artist ?? (draft.artist ?? '')}
          onChange={(event) => setArtist(event.target.value)}
          onBlur={() => discardRejection(flushPendingEdits)}
          placeholder="Artist"
          disabled={busy}
        />
      </div>

      {draft.duplicate_tracks.length > 0 ? (
        <div className="import-row-dup">
          <span className="import-row-dup-label">
            {draft.duplicate_tracks.length === 1
              ? `"${draft.duplicate_tracks[0].title}" is already in your library`
              : `${draft.duplicate_tracks.length} existing songs match`}
          </span>
          <div className="import-row-dup-choices" role="group" aria-label="Handle duplicate">
            <button
              type="button"
              className={`import-dup-choice ${draft.duplicate_action === 'create-new' ? 'is-selected' : ''}`}
              disabled={busy}
              onClick={() => discardRejection(() => onUpdate({ duplicate_action: 'create-new', existing_track_id: null }))}
            >
              Keep as new
            </button>
            <button
              type="button"
              className={`import-dup-choice ${draft.duplicate_action === 'reuse-existing' ? 'is-selected' : ''}`}
              disabled={busy}
              onClick={() => discardRejection(() => onUpdate({
                duplicate_action: 'reuse-existing',
                existing_track_id: draft.duplicate_tracks.length === 1
                  ? (draft.duplicate_tracks[0]?.id ?? null)
                  : draft.existing_track_id,
              }))}
            >
              Use existing song
            </button>
            <button
              type="button"
              className={`import-dup-choice import-dup-choice-skip ${draft.duplicate_action === 'skip' ? 'is-selected' : ''}`}
              disabled={busy}
              onClick={() => discardRejection(() => onUpdate({ duplicate_action: 'skip', existing_track_id: null }))}
            >
              Skip
            </button>
          </div>
          {draft.duplicate_action === 'reuse-existing' && draft.duplicate_tracks.length > 1 ? (
            <div className="import-row-dup-tracks">
              {draft.duplicate_tracks.map((match: ExistingTrackDuplicate) => (
                <button
                  key={match.id}
                  type="button"
                  className={`import-dup-track-btn ${draft.existing_track_id === match.id ? 'is-selected' : ''}`}
                  disabled={busy}
                  onClick={() => discardRejection(() => onUpdate({ duplicate_action: 'reuse-existing', existing_track_id: match.id }))}
                >
                  <span className="import-dup-track-name">{match.title}</span>
                  {match.artist ? <span className="import-dup-track-artist">{match.artist}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          {draft.duplicate_action === 'skip' ? (
            <span className="import-row-dup-hint">This import will be discarded.</span>
          ) : draft.duplicate_action === 'reuse-existing' ? (
            <span className="import-row-dup-hint">No new copy will be added; the existing song remains available.</span>
          ) : null}
        </div>
      ) : null}
    </article>
  )
})

// ---- ImportPanel -----------------------------------------------------------

export function ImportPanel(props: ImportPanelProps) {
  if (!props.open) return null
  return <ImportPanelContent {...props} />
}

function ImportPanelContent({
  drafts,
  stemOptions,
  qualityOptions,
  defaultSelection,
  resolvingYoutubeImport,
  resolvingLocalImport,
  confirming,
  onClose,
  onResolveYouTube,
  onResolveLocalImport,
  onUpdateDraft,
  onDiscardDraft,
  onConfirm,
}: ImportPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  // When no drafts are staged, direct focus to the URL field so the user can
  // immediately paste or type without an extra click.
  const initialFocusRef = drafts.length === 0 ? urlInputRef : closeButtonRef
  useDialogFocus(true, { containerRef: panelRef, initialFocusRef })

  // ---- Source section state -----------------------------------------------

  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [localFiles, setLocalFiles] = useState<File[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const pendingYouTubeUrlRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  function resetSourceInputs() {
    setYoutubeUrl('')
    setLocalFiles([])
    setDragActive(false)
    setSourceError(null)
    pendingYouTubeUrlRef.current = null
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function clearYouTubeSource() {
    setYoutubeUrl('')
    setSourceError(null)
    pendingYouTubeUrlRef.current = null
  }

  async function resolveYouTubeSource(url: string) {
    const trimmed = url.trim()
    if (!trimmed) return
    if (pendingYouTubeUrlRef.current === trimmed) return

    setSourceError(null)
    pendingYouTubeUrlRef.current = trimmed
    try {
      await onResolveYouTube(trimmed)
      resetSourceInputs()
    } catch (raw) {
      setSourceError(raw instanceof Error ? raw.message : 'Could not resolve URL.')
    } finally {
      if (pendingYouTubeUrlRef.current === trimmed) {
        pendingYouTubeUrlRef.current = null
      }
    }
  }

  async function stageYouTube() {
    const trimmed = youtubeUrl.trim()
    if (!trimmed) return
    await resolveYouTubeSource(trimmed)
  }

  async function resolveLocalFiles(files: File[]) {
    if (!files.length) return
    setLocalFiles(files)
    setSourceError(null)
    try {
      await onResolveLocalImport(files)
      resetSourceInputs()
    } catch (raw) {
      setLocalFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ''
      setSourceError(raw instanceof Error ? raw.message : 'Could not stage those files.')
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    setDragActive(false)
    const accepted = filterImportableMediaFiles(event.dataTransfer.files)
    if (accepted.length === 0) {
      setSourceError('Drop audio or video files.')
      return
    }
    setSourceError(null)
    discardRejection(() => resolveLocalFiles(accepted))
  }

  const sourceBusy = resolvingYoutubeImport || resolvingLocalImport

  const playlistHint = youtubeUrl.trim() && looksLikePlaylist(youtubeUrl)
    ? 'Playlists can take up to 30 seconds to resolve.'
    : null

  // ---- Review section state -----------------------------------------------

  const [selection, setSelection] = useProcessingSelection(defaultSelection)
  const [pendingDraftActions, setPendingDraftActions] = useState<Record<string, number>>({})
  const rowRefs = useRef<Record<string, ImportRowHandle | null>>({})
  const hasPendingDraftActions = Object.keys(pendingDraftActions).length > 0

  const unresolved = drafts.filter(needsDuplicateDecision).length
  const createNew = countAction(drafts, 'create-new')
  const reuse = countAction(drafts, 'reuse-existing')
  const skip = countAction(drafts, 'skip')
  const importableCount = createNew + reuse
  const canConfirm = drafts.length > 0 && unresolved === 0 && !confirming && !hasPendingDraftActions
  const selectedStemLabel = stemSelectionLabel(selection.stems, stemOptions)

  const ordered = [...drafts].sort((a, b) => {
    const aNeeds = needsDuplicateDecision(a) ? 1 : 0
    const bNeeds = needsDuplicateDecision(b) ? 1 : 0
    if (aNeeds !== bNeeds) return bNeeds - aNeeds
    return a.title.localeCompare(b.title)
  })

  function setDraftActionPending(draftId: string, active: boolean) {
    setPendingDraftActions((current) => {
      const currentCount = current[draftId] ?? 0
      const nextCount = active ? currentCount + 1 : Math.max(0, currentCount - 1)
      if (nextCount === currentCount) return current
      if (nextCount === 0) {
        const next = { ...current }
        delete next[draftId]
        return next
      }
      return { ...current, [draftId]: nextCount }
    })
  }

  async function runDraftAction(draftId: string, action: () => Promise<void>) {
    setDraftActionPending(draftId, true)
    try {
      await action()
    } finally {
      setDraftActionPending(draftId, false)
    }
  }

  async function flushDraftEdits(draftId: string) {
    await rowRefs.current[draftId]?.flushPendingEdits()
  }

  async function flushAllDraftEdits() {
    for (const draft of drafts) {
      await flushDraftEdits(draft.id)
    }
  }

  async function confirm(queue: boolean) {
    if (!canConfirm) return
    await flushAllDraftEdits()
    await onConfirm({
      draft_ids: drafts.map((item) => item.id),
      queue,
      processing: queue ? selection : undefined,
    })
  }

  // ---- Render ---------------------------------------------------------------

  const sourceControls = (
    <>
      <div className="import-panel-url-row">
        <div className="import-panel-url-wrap">
          <input
            ref={urlInputRef}
            type="url"
            className="import-panel-url-input"
            placeholder="Paste YouTube URL or playlist"
            value={youtubeUrl}
            onChange={(event) => {
              setYoutubeUrl(event.target.value)
              if (sourceError) setSourceError(null)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !youtubeUrl.trim() || sourceBusy) return
              event.preventDefault()
              discardRejection(stageYouTube)
            }}
            disabled={sourceBusy}
            aria-label="YouTube URL"
          />
          {youtubeUrl && !sourceBusy ? (
            <button
              type="button"
              className="import-panel-url-clear"
              onClick={clearYouTubeSource}
              aria-label="Clear URL"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
                <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="button-primary"
          disabled={!youtubeUrl.trim() || sourceBusy}
          onClick={() => discardRejection(stageYouTube)}
        >
          {resolvingYoutubeImport ? <><Spinner /> Resolving…</> : 'Add'}
        </button>
      </div>

      {playlistHint ? (
        <p className="import-panel-hint">{playlistHint}</p>
      ) : !youtubeUrl && !drafts.length ? (
        <p className="import-panel-hint">Paste a URL here or drop audio and video files below.</p>
      ) : null}

      <div className="import-panel-or" aria-hidden>or</div>

      <div
        className={`import-panel-drop ${dragActive ? 'is-active' : ''} ${localFiles.length > 0 ? 'is-loaded' : ''}`}
        onDrop={handleDrop}
        onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setDragActive(true) }}
        onDragLeave={(event) => { event.preventDefault(); event.stopPropagation(); setDragActive(false) }}
        onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); setDragActive(true) }}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Drop audio or video files, or press Enter to browse"
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            fileInputRef.current?.click()
          }
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,video/*"
          multiple
          disabled={sourceBusy}
          onChange={(event) => {
            const accepted = filterImportableMediaFiles(event.target.files ?? [])
            if (accepted.length > 0) {
              discardRejection(() => resolveLocalFiles(accepted))
              return
            }
            setLocalFiles([])
            setSourceError('Choose audio or video files.')
          }}
          hidden
        />
        {localFiles.length > 0 ? (
          <span className="import-panel-drop-label">
            {resolvingLocalImport ? <Spinner /> : <CheckIcon />}
            <strong>
              {resolvingLocalImport
                ? `Adding ${localFiles.length} file${localFiles.length === 1 ? '' : 's'}`
                : `${localFiles.length} file${localFiles.length === 1 ? '' : 's'} added`}
            </strong>
            <span>{resolvingLocalImport ? localFiles.map((f) => f.name).join(', ') : 'Review the staged songs below.'}</span>
          </span>
        ) : (
          <span className="import-panel-drop-label">
            <UploadIcon />
            <strong>Drop audio or video files</strong>
            <span>Click to browse instead</span>
          </span>
        )}
      </div>

      {sourceError ? (
        <p className="import-panel-error" role="alert">{sourceError}</p>
      ) : null}
    </>
  )

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Add songs"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="overlay-panel" ref={panelRef} tabIndex={-1}>
        <header className="overlay-head">
          <div className="overlay-head-copy">
            <h2>Add songs</h2>
            <p>Add files or YouTube links, review matches, then choose what happens next.</p>
          </div>
          <button ref={closeButtonRef} type="button" className="button-secondary" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="overlay-body">
          {/* ---- Source input ------------------------------------------- */}
          {drafts.length > 0 ? (
            <details className="import-panel-source import-panel-source-collapsed">
              <summary>
                <strong>Add more songs</strong>
                <span>Keep the current review in place.</span>
              </summary>
              {sourceControls}
            </details>
          ) : (
            <div className="import-panel-source">
              {sourceControls}
            </div>
          )}

          {/* ---- Staged review ------------------------------------------ */}
          {drafts.length > 0 ? (
            <>
              <div className="import-panel-divider">
                <span>{drafts.length} {drafts.length === 1 ? 'song' : 'songs'} to import</span>
                <span className="import-panel-divider-stats">
                  {createNew > 0 ? <span>{createNew} new</span> : null}
                  {reuse > 0 ? <span>{reuse} existing song{reuse === 1 ? '' : 's'}</span> : null}
                  {skip > 0 ? <span>{skip} skipped</span> : null}
                </span>
              </div>

              {ordered.map((draft) => (
                <ImportRow
                  key={draft.id}
                  ref={(value) => { rowRefs.current[draft.id] = value }}
                  draft={draft}
                  busy={confirming || !!pendingDraftActions[draft.id]}
                  onUpdate={(payload) => runDraftAction(draft.id, () => onUpdateDraft(draft.id, payload))}
                  onDiscard={() =>
                    discardRejection(async () => {
                      await flushDraftEdits(draft.id)
                      await runDraftAction(draft.id, () => onDiscardDraft(draft.id))
                    })
                  }
                />
              ))}
            </>
          ) : null}
        </div>

        {drafts.length > 0 ? (
          <footer className="overlay-foot">
            <StemSelectionPicker
              value={selection}
              stemOptions={stemOptions}
              qualityOptions={qualityOptions}
              disabled={confirming}
              compact
              onChange={setSelection}
            />
            <div className="overlay-foot-bottom">
              <div className="overlay-foot-copy">
                {hasPendingDraftActions
                  ? 'Saving…'
                  : unresolved > 0
                    ? `${unresolved} duplicate${unresolved === 1 ? '' : 's'} to resolve`
                    : importableCount === 0
                      ? 'No songs will be imported.'
                    : selection.stems.length
                      ? `Import ${importableCount} song${importableCount === 1 ? '' : 's'} and queue ${selectedStemLabel}.`
                      : 'Choose stems to process now, or import only.'}
              </div>
              <div className="overlay-foot-actions">
                <button
                  type="button"
                  className="button-primary"
                  disabled={!canConfirm || selection.stems.length === 0}
                  onClick={() => discardRejection(() => confirm(true))}
                >
                  {confirming ? <><Spinner /> Importing…</> : 'Import and queue stem sets'}
                </button>
                <button
                  type="button"
                  className="button-link import-only-action"
                  disabled={!canConfirm}
                  onClick={() => discardRejection(() => confirm(false))}
                  title="Add to the library without processing yet. You can create a stem set from the song list."
                >
                  Import only
                </button>
              </div>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  )
}
