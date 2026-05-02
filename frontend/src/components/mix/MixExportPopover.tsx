import { ExportBuilder } from '../export/ExportBuilder'
import type { RevealFolderInput, RunDetail, TrackDetail } from '../../types'

type MixExportPopoverProps = {
  track: TrackDetail
  run: RunDetail
  defaultBitrate: string
  onClose: () => void
  onReveal: (payload: RevealFolderInput) => void | Promise<void>
  onError: (message: string) => void
}

export function MixExportPopover({
  track,
  run,
  defaultBitrate,
  onClose,
  onReveal,
  onError,
}: MixExportPopoverProps) {
  return (
    <>
      <div className="popover-backdrop" onClick={onClose} aria-hidden />
      <div className="popover popover-right popover-wide" role="dialog" aria-label="Export audio">
        <div className="popover-title">Export audio</div>
        <ExportBuilder
          selectedTrackIds={[track.id]}
          runIds={{ [track.id]: run.id }}
          defaultBitrate={defaultBitrate}
          onError={onError}
          onReveal={onReveal}
          variant="compact"
          footerAction={
            <button type="button" className="button-link" onClick={onClose}>
              Close
            </button>
          }
        />
      </div>
    </>
  )
}
