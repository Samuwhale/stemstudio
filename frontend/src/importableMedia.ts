const IMPORTABLE_MEDIA_EXTENSIONS = [
  '.aac',
  '.aif',
  '.aiff',
  '.alac',
  '.avi',
  '.flac',
  '.m4a',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
  '.wma',
] as const

const IMPORTABLE_MEDIA_EXTENSION_SET = new Set<string>(IMPORTABLE_MEDIA_EXTENSIONS)

export const IMPORTABLE_MEDIA_HINT = `Use ${IMPORTABLE_MEDIA_EXTENSIONS.join(', ')} files.`
export const IMPORTABLE_MEDIA_ACCEPT = IMPORTABLE_MEDIA_EXTENSIONS.join(',')

export function unsupportedImportableMediaMessage(count: number) {
  return `Ignored ${count} unsupported file${count === 1 ? '' : 's'}. ${IMPORTABLE_MEDIA_HINT}`
}

function hasImportableExtension(filename: string) {
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex < 0) return false
  return IMPORTABLE_MEDIA_EXTENSION_SET.has(filename.slice(dotIndex).toLowerCase())
}

function isImportableMediaFile(file: File) {
  return hasImportableExtension(file.name)
}

export function filterImportableMediaFiles(files: Iterable<File>) {
  return Array.from(files).filter(isImportableMediaFile)
}
