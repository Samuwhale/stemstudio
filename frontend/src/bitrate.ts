export const MP3_BITRATE_HINT = 'Use a value like 192k or 320k.'

const MP3_BITRATE_PATTERN = /^\d{2,3}k$/

export function normalizeMp3Bitrate(value: string) {
  return value.trim().toLowerCase()
}

export function isMp3Bitrate(value: string) {
  return MP3_BITRATE_PATTERN.test(normalizeMp3Bitrate(value))
}
