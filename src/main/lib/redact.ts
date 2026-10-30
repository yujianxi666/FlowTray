import { homedir } from 'node:os'

const HOME = homedir()
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const SENSITIVE_KEYS = new Set([
  'content',
  'text',
  'textcontent',
  'html',
  'htmlcontent',
  'clipboard',
  'clipboardtext',
  'body',
  'preview',
  'url'
])

export function redactString(value: string): string {
  let result = value.replace(WINDOWS_PATH, '<path>')
  if (HOME) {
    result = result.split(HOME).join('%USERPROFILE%')
  }
  result = result.replace(EMAIL, '<email>')
  return result
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '<deep>'
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack).split('\n').slice(0, 6).join('\n') : undefined
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((entry) => redactValue(entry, depth + 1))
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = '<redacted>'
        continue
      }
      result[key] = redactValue(entry, depth + 1)
    }
    return result
  }
  return String(value)
}
