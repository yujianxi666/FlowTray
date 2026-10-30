import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { redactValue } from './redact'

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
