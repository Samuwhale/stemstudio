import { useMemo, useRef } from 'react'

import { discardRejection } from '../../async'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useProcessingSelection } from '../../hooks/useProcessingSelection'
import { stemSelectionLabel } from '../../stems'
import { StemSelectionPicker } from '../StemSelectionPicker'
import { Spinner } from '../feedback/Spinner'
import { planBatchStemSelection } from '../trackListView'
import type {
  QualityOption,
  RunProcessingConfigInput,
  StemOption,
  TrackSummary,
} from '../../types'

type BatchStemOverlayProps = {
  open: boolean
  tracks: TrackSummary[]
  selectedTrackIds: string[]
  stemOptions: StemOption[]
  qualityOptions: QualityOption[]
  defaultSelection: RunProcessingConfigInput
  busy: boolean
  onClose: () => void
  onConfirm: (trackIds: string[], processing: RunProcessingConfigInput) => Promise<void>
}

export function BatchStemOverlay(props: BatchStemOverlayProps) {
  if (!props.open) return null
  return <BatchStemOverlayContent {...props} />
}

function BatchStemOverlayContent({
  tracks,
  selectedTrackIds,
  stemOptions,
  qualityOptions,
  defaultSelection,
  busy,
  onClose,
  onConfirm,
}: BatchStemOverlayProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  useDialogFocus(true, { containerRef: panelRef, initialFocusRef: closeButtonRef })

  const [selection, setSelection] = useProcessingSelection(defaultSelection)

  const rows = useMemo(
    () => planBatchStemSelection(tracks, selectedTrackIds),
    [selectedTrackIds, tracks],
  )

  const eligibleRows = rows.filter((row) => row.eligible)
  const skippedRows = rows.filter((row) => !row.eligible)
  const eligibleIds = eligibleRows.map((row) => row.track.id)

  async function handleConfirm() {
    if (!eligibleIds.length || selection.stems.length === 0) return
    await onConfirm(eligibleIds, selection)
  }

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Queue stem sets"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="overlay-panel overlay-panel-wide" ref={panelRef} tabIndex={-1}>
        <header className="overlay-head">
          <h2>Queue stem sets</h2>
          <button ref={closeButtonRef} type="button" className="button-secondary" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="overlay-body">
          {rows.length === 0 ? (
            <p className="imports-empty">No tracks selected.</p>
          ) : (
            <div className="batch-stems">
              <div className="batch-stems-summary" aria-live="polite">
                <strong>
                  {eligibleRows.length} song{eligibleRows.length === 1 ? '' : 's'} ready
                </strong>
                <span>
                  {rows.length} selected
                  {skippedRows.length > 0
                    ? ` · ${skippedRows.length} already processing`
                    : ''}
                </span>
              </div>

              <StemSelectionPicker
                value={selection}
                stemOptions={stemOptions}
                qualityOptions={qualityOptions}
                disabled={busy || !eligibleRows.length}
                compact
                onChange={setSelection}
              />

              {skippedRows.length > 0 ? (
                <details className="batch-stems-skipped">
                  <summary>
                    {skippedRows.length} skipped because stem creation is already running
                  </summary>
                  <ul>
                    {skippedRows.map((row) => (
                      <li key={row.track.id}>
                        <strong>{row.track.title}</strong>
                        <span>{row.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <div className="import-footer">
                {eligibleRows.length === 0 ? (
                  <span>None of the selected songs can queue a stem set right now.</span>
                ) : (
                  <span>
                    {selection.stems.length
                      ? `Create ${stemSelectionLabel(selection.stems, stemOptions)} for the ready songs.`
                      : 'Choose stems to create.'}
                  </span>
                )}
                <button
                  type="button"
                  className="button-primary"
                  disabled={busy || eligibleRows.length === 0 || selection.stems.length === 0}
                  onClick={() => discardRejection(handleConfirm)}
                >
                  {busy ? (
                    <>
                      <Spinner /> Queueing
                    </>
                  ) : (
                    `Queue ${eligibleRows.length} stem set${eligibleRows.length === 1 ? '' : 's'}`
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
