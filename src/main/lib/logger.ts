import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_LOG_BYTES = 2 * 1024 * 1024

export class Logger {
  private file: string | null = null
  private level: Level = 'info'

  init(directory: string, level: Level = 'info'): void {
    this.level = level
    try {
      mkdirSync(directory, { recursive: true })
      this.file = join(directory, 'main.log')
      this.rotateIfNeeded()
    } catch {
      this.file = null
    }
  }

  setLevel(level: Level): void {
    this.level = level
  }

  get path(): string | null {
    return this.file
  }

  debug(event: string, data?: unknown): void {
    this.write('debug', event, data)
  }

  info(event: string, data?: unknown): void {
    this.write('info', event, data)
  }

  warn(event: string, data?: unknown): void {
    this.write('warn', event, data)
  }

  error(event: string, data?: unknown): void {
    this.write('error', event, data)
  }

  private rotateIfNeeded(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      if (statSync(this.file).size < MAX_LOG_BYTES) return
      const backup = `${this.file}.1`
      if (existsSync(backup)) unlinkSync(backup)
      renameSync(this.file, backup)
    } catch {
      // Logging must never break the app.
    }
  }

  private write(level: Level, event: string, data?: unknown): void {
    const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
    if (order[level] < order[this.level]) return
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event
    }
    if (data !== undefined) {
      payload.data = redactValue(data)
    }
    const line = `${JSON.stringify(payload)}\n`
    if (!this.file) {
      if (!app.isPackaged) process.stdout.write(line)
      return
    }
    try {
      appendFileSync(this.file, line, 'utf8')
    } catch {
      // ignore
    }
  }
}

export const logger = new Logger()

const HOME = homedir()
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

export function redactString(value: string): string {
  let result = value
  if (HOME) {
    result = result.split(HOME).join('%USERPROFILE%')
  }
  result = result.replace(WINDOWS_PATH, '<path>')
  result = result.replace(EMAIL, '<email>')
  return result
}

function redactValue(value: unknown, depth = 0): unknown {
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
      result[key] = redactValue(entry, depth + 1)
    }
    return result
  }
  return String(value)
}
