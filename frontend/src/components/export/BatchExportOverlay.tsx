import { useRef } from 'react'

import { useDialogFocus } from '../../hooks/useDialogFocus'
import type { RevealFolderInput, TrackSummary } from '../../types'
import { planBatchExportSelection, trackStageSummary } from '../trackListView'
import { ExportBuilder } from './ExportBuilder'

type BatchExportOverlayProps = {
  open: boolean
  tracks: TrackSummary[]
  selectedTrackIds: string[]
  defaultBitrate: string
  onClose: () => void
  onReveal: (payload: RevealFolderInput) => void | Promise<void>
  onError: (message: string) => void
}

export function BatchExportOverlay(props: BatchExportOverlayProps) {
  if (!props.open) return null
  return <BatchExportOverlayContent {...props} />
}

function BatchExportOverlayContent({
  tracks,
  selectedTrackIds,
  defaultBitrate,
  onClose,
  onReveal,
  onError,
}: BatchExportOverlayProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  useDialogFocus(true, { containerRef: panelRef, initialFocusRef: closeButtonRef })
  const { skippedTracks, runIds, exportableIds } = planBatchExportSelection(tracks, selectedTrackIds)

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Export selection"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="overlay-panel overlay-panel-wide" ref={panelRef} tabIndex={-1}>
        <header className="overlay-head">
          <div className="overlay-head-copy">
            <h2>
              Export {exportableIds.length} of {selectedTrackIds.length} selected song
              {selectedTrackIds.length === 1 ? '' : 's'}
            </h2>
            {skippedTracks.length > 0 ? (
              <p>{skippedTracks.length} not ready for export yet.</p>
            ) : null}
          </div>
          <button ref={closeButtonRef} type="button" className="button-secondary" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="overlay-body">
          {skippedTracks.length > 0 ? (
            <details className="export-selection-skipped">
              <summary>Skipped songs</summary>
              <ul>
                {skippedTracks.map((track) => {
                  const stage = trackStageSummary(track)
                  return (
                    <li key={track.id}>
                      <strong>{track.title}</strong>
                      <span>{stage.label}</span>
                    </li>
                  )
                })}
              </ul>
            </details>
          ) : null}
          {exportableIds.length === 0 ? (
            <p className="imports-empty">No exportable tracks in this selection.</p>
          ) : (
            <ExportBuilder
              selectedTrackIds={exportableIds}
              defaultBitrate={defaultBitrate}
              runIds={runIds}
              onReveal={onReveal}
              onError={onError}
            />
          )}
        </div>
      </div>
    </div>
  )
}
