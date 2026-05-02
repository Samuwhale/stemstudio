import { useCallback, useMemo, useState } from 'react'
import type { SetStateAction } from 'react'

import { sortStemNames } from '../stems'
import type { RunProcessingConfigInput } from '../types'

function normalizeProcessingSelection(
  selection: RunProcessingConfigInput,
): RunProcessingConfigInput {
  return {
    quality: selection.quality,
    stems: sortStemNames(selection.stems),
  }
}

export function processingSelectionKey(selection: RunProcessingConfigInput): string {
  const normalized = normalizeProcessingSelection(selection)
  return `${normalized.quality}:${normalized.stems.join(',')}`
}

export function useProcessingSelection(defaultSelection: RunProcessingConfigInput) {
  const normalizedDefaultSelection = useMemo(
    () => normalizeProcessingSelection(defaultSelection),
    [defaultSelection],
  )
  const defaultSelectionKey = useMemo(
    () => processingSelectionKey(normalizedDefaultSelection),
    [normalizedDefaultSelection],
  )
  const [state, setState] = useState(() => ({
    defaultSelectionKey,
    selection: normalizedDefaultSelection,
  }))
  const selection =
    state.defaultSelectionKey === defaultSelectionKey
      ? state.selection
      : normalizedDefaultSelection

  const setSelection = useCallback((next: SetStateAction<RunProcessingConfigInput>) => {
    setState((current) => {
      const currentSelection =
        current.defaultSelectionKey === defaultSelectionKey
          ? current.selection
          : normalizedDefaultSelection
      const resolvedSelection =
        typeof next === 'function'
          ? (next as (current: RunProcessingConfigInput) => RunProcessingConfigInput)(
              currentSelection,
            )
          : next

      return {
        defaultSelectionKey,
        selection: normalizeProcessingSelection(resolvedSelection),
      }
    })
  }, [defaultSelectionKey, normalizedDefaultSelection])

  return [selection, setSelection] as const
}
