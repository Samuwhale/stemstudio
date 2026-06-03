import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { fetchApiResponse } from '../../api'
import { discardRejection } from '../../async'

type MixerStemInput = {
  artifact_id: string
  url: string
  gain_db: number
  muted: boolean
  soloed: boolean
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

type StemRuntime = {
  source: AudioBufferSourceNode | null
  gain: GainNode
}

const GAIN_RAMP_SECONDS = 0.05

function dbToLinear(db: number) {
  return Math.pow(10, db / 20)
}

function effectiveGain(stems: MixerStemInput[], stem: MixerStemInput) {
  if (stem.muted) return 0
  const anySoloed = stems.some((other) => other.soloed)
  if (anySoloed && !stem.soloed) return 0
  return dbToLinear(stem.gain_db)
}

const bufferCache = new Map<string, Promise<AudioBuffer>>()

async function loadBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  let pending = bufferCache.get(url)
  if (!pending) {
    pending = fetchApiResponse(url)
      .then((response) => response.arrayBuffer())
      .then((buffer) => ctx.decodeAudioData(buffer.slice(0)))
      .catch((error) => {
        bufferCache.delete(url)
        throw error
      })
    bufferCache.set(url, pending)
  }
  return pending
}

export function useStemMixer(stems: MixerStemInput[]) {
  const [, setLoadRevision] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  const ctxRef = useRef<AudioContext | null>(null)
  const buffersRef = useRef<Map<string, AudioBuffer>>(new Map())
  const runtimeRef = useRef<Map<string, StemRuntime>>(new Map())
  const loadStateRef = useRef<LoadState>('idle')
  const loadKeyRef = useRef('')
  const durationRef = useRef(0)
  const errorRef = useRef<string | null>(null)
  const startCtxTimeRef = useRef(0)
  const startOffsetRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const loadableStemsRef = useRef<Array<{ artifact_id: string; url: string }>>([])

  const stemKeys = useMemo(
    () => stems.map((stem) => `${stem.artifact_id}|${stem.url}`).join(','),
    [stems],
  )

  useEffect(() => {
    loadableStemsRef.current = stems.map((stem) => ({ artifact_id: stem.artifact_id, url: stem.url }))
  }, [stems])

  useEffect(() => {
    const loadableStems = loadableStemsRef.current
    if (!loadableStems.length) {
      buffersRef.current = new Map()
      loadKeyRef.current = ''
      loadStateRef.current = 'idle'
      durationRef.current = 0
      errorRef.current = null
      return
    }

    let cancelled = false

    const ctx = ctxRef.current ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    ctxRef.current = ctx

    async function loadAll() {
      try {
        const results = await Promise.all(
          loadableStems.map(async (stem) => {
            const buffer = await loadBuffer(ctx, stem.url)
            return { stem, buffer }
          }),
        )
        if (cancelled) return
        const nextBuffers = new Map<string, AudioBuffer>()
        let maxDuration = 0
        for (const { stem, buffer } of results) {
          nextBuffers.set(stem.artifact_id, buffer)
          if (buffer.duration > maxDuration) maxDuration = buffer.duration
        }
        buffersRef.current = nextBuffers
        loadKeyRef.current = stemKeys
        loadStateRef.current = 'ready'
        durationRef.current = maxDuration
        errorRef.current = null
        setCurrentTime(0)
        setIsPlaying(false)
        setLoadRevision((value) => value + 1)
      } catch (caught) {
        if (cancelled) return
        loadKeyRef.current = stemKeys
        loadStateRef.current = 'error'
        durationRef.current = 0
        errorRef.current = caught instanceof Error ? caught.message : 'Could not load stems for preview.'
        setCurrentTime(0)
        setIsPlaying(false)
        setLoadRevision((value) => value + 1)
      }
    }

    discardRejection(loadAll)
    return () => {
      cancelled = true
    }
  }, [stemKeys])

  const stopSources = useCallback(() => {
    const runtime = runtimeRef.current
    runtime.forEach((entry) => {
      if (entry.source) {
        try {
          entry.source.stop()
        } catch {
          // already stopped
        }
        entry.source.disconnect()
        entry.source = null
      }
    })
  }, [])

  const teardown = useCallback(() => {
    stopSources()
    const runtime = runtimeRef.current
    runtime.forEach((entry) => entry.gain.disconnect())
    runtime.clear()
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [stopSources])

  useEffect(() => {
    teardown()
  }, [stemKeys, teardown])

  useEffect(() => {
    return () => {
      teardown()
      const ctx = ctxRef.current
      if (ctx) {
        discardRejection(() => ctx.close())
        ctxRef.current = null
      }
    }
  }, [teardown])

  const updateGains = useCallback(
    (nextStems: MixerStemInput[]) => {
      const ctx = ctxRef.current
      if (!ctx) return
      const runtime = runtimeRef.current
      for (const stem of nextStems) {
        const entry = runtime.get(stem.artifact_id)
        if (!entry) continue
        const target = effectiveGain(nextStems, stem)
        entry.gain.gain.cancelScheduledValues(ctx.currentTime)
        entry.gain.gain.setTargetAtTime(target, ctx.currentTime, GAIN_RAMP_SECONDS)
      }
    },
    [],
  )

  useEffect(() => {
    updateGains(stems)
  }, [stems, updateGains])

  const resolvedLoadState: LoadState =
    stems.length === 0
      ? 'idle'
      : loadKeyRef.current === stemKeys
        ? loadStateRef.current
        : 'loading'
  const resolvedDuration = resolvedLoadState === 'ready' ? durationRef.current : 0
  const resolvedError = resolvedLoadState === 'error' ? errorRef.current : null

  function scheduleNextFrame() {
    rafRef.current = requestAnimationFrame(() => {
      const ctx = ctxRef.current
      if (!ctx) {
        rafRef.current = null
        return
      }
      const elapsed = ctx.currentTime - startCtxTimeRef.current + startOffsetRef.current
      if (elapsed >= resolvedDuration) {
        stopSources()
        setIsPlaying(false)
        setCurrentTime(resolvedDuration)
        rafRef.current = null
        return
      }
      setCurrentTime(elapsed)
      scheduleNextFrame()
    })
  }

  function play(fromSeconds?: number) {
    const ctx = ctxRef.current
    if (!ctx || resolvedLoadState !== 'ready') return
    if (ctx.state === 'suspended') discardRejection(() => ctx.resume())

    stopSources()
    const offset = Math.max(0, Math.min(resolvedDuration, fromSeconds ?? currentTime))
    startOffsetRef.current = offset
    startCtxTimeRef.current = ctx.currentTime

    const runtime = runtimeRef.current
    for (const stem of stems) {
      const buffer = buffersRef.current.get(stem.artifact_id)
      if (!buffer) continue
      let entry = runtime.get(stem.artifact_id)
      if (!entry) {
        const gain = ctx.createGain()
        gain.connect(ctx.destination)
        gain.gain.value = effectiveGain(stems, stem)
        entry = { source: null, gain }
        runtime.set(stem.artifact_id, entry)
      } else {
        entry.gain.gain.setValueAtTime(effectiveGain(stems, stem), ctx.currentTime)
      }
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(entry.gain)
      if (offset < buffer.duration) {
        source.start(ctx.currentTime, offset)
      }
      entry.source = source
    }

    setIsPlaying(true)
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    scheduleNextFrame()
  }

  function pause() {
    const ctx = ctxRef.current
    if (!ctx) return
    const elapsed = Math.min(
      resolvedDuration,
      ctx.currentTime - startCtxTimeRef.current + startOffsetRef.current,
    )
    stopSources()
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setCurrentTime(elapsed)
    setIsPlaying(false)
  }

  function seek(seconds: number) {
    const bounded = Math.max(0, Math.min(resolvedDuration, seconds))
    setCurrentTime(bounded)
    if (isPlaying) {
      play(bounded)
    }
  }

  return {
    loadState: resolvedLoadState,
    isPlaying: stems.length && resolvedLoadState === 'ready' ? isPlaying : false,
    currentTime: stems.length && resolvedLoadState === 'ready' ? currentTime : 0,
    duration: resolvedDuration,
    error: resolvedError,
    play,
    pause,
    seek,
  }
}
