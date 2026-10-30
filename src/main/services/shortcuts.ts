import { globalShortcut } from 'electron'
import type { HotkeyStatus } from '@shared/types'
import { logger } from '@main/lib/logger'

export interface ShortcutCallbacks {
  onToggle: () => void
  onCapture: () => void
}

export interface ShortcutApplyResult {
  ok: boolean
  toggle: HotkeyStatus
  capture: HotkeyStatus
  error?: string
}

export class ShortcutManager {
  private current: { toggle: string; capture: string } | null = null
  private toggleStatus: HotkeyStatus = { accelerator: '', ok: false }
  private captureStatus: HotkeyStatus = { accelerator: '', ok: false }
  private suspended = false
  private deferred: { toggle: string; capture: string } | null = null

  constructor(private readonly callbacks: ShortcutCallbacks) {}

  statuses(): { toggle: HotkeyStatus; capture: HotkeyStatus } {
    return {
      toggle: { ...this.toggleStatus },
      capture: { ...this.captureStatus }
    }
  }

  apply(settings: { hotkeyToggle: string; hotkeyCapture: string }): ShortcutApplyResult {
    const desired = { toggle: settings.hotkeyToggle.trim(), capture: settings.hotkeyCapture.trim() }
    if (!desired.toggle || !desired.capture) {
      return this.failure(desired, '快捷键不能为空。')
    }
    if (desired.toggle === desired.capture) {
      return this.failure(desired, '“呼出/隐藏”和“剪贴板存入”不能使用同一个快捷键。')
    }
    if (this.suspended) {
      const probe = this.probeBoth(desired)
      if (!probe.ok) return this.failure(desired, probe.error ?? '快捷键注册失败。')
      this.deferred = desired
      this.toggleStatus = { accelerator: desired.toggle, ok: true }
      this.captureStatus = { accelerator: desired.capture, ok: true }
      return {
        ok: true,
        toggle: this.toggleStatus,
        capture: this.captureStatus
      }
    }

    const previous = this.current
    globalShortcut.unregisterAll()
    const toggleResult = this.registerOne(desired.toggle, this.callbacks.onToggle)
    const captureResult = this.registerOne(desired.capture, this.callbacks.onCapture)
    if (!toggleResult.ok || !captureResult.ok) {
      globalShortcut.unregisterAll()
      if (previous) {
        this.registerOne(previous.toggle, this.callbacks.onToggle)
        this.registerOne(previous.capture, this.callbacks.onCapture)
      }
      const message = !toggleResult.ok
        ? `“呼出/隐藏”快捷键 ${desired.toggle} 注册失败，可能被其他应用占用。`
        : `“剪贴板存入”快捷键 ${desired.capture} 注册失败，可能被其他应用占用。`
      return this.failure(desired, message)
    }

    this.current = desired
    this.toggleStatus = { accelerator: desired.toggle, ok: true }
    this.captureStatus = { accelerator: desired.capture, ok: true }
    this.deferred = null
    logger.info('shortcuts.registered', desired)
    return {
      ok: true,
      toggle: this.toggleStatus,
      capture: this.captureStatus
    }
  }

  private probeBoth(desired: { toggle: string; capture: string }): {
    ok: boolean
    error?: string
  } {
    const toggleProbe = this.probe(desired.toggle)
    if (!toggleProbe) {
      return { ok: false, error: `“呼出/隐藏”快捷键 ${desired.toggle} 已被占用。` }
    }
    const captureProbe = this.probe(desired.capture)
    if (!captureProbe) {
      return { ok: false, error: `“剪贴板存入”快捷键 ${desired.capture} 已被占用。` }
    }
    return { ok: true }
  }

  private probe(accelerator: string): boolean {
    try {
      if (!globalShortcut.register(accelerator, () => undefined)) return false
      globalShortcut.unregister(accelerator)
      return true
    } catch {
      return false
    }
  }

  private registerOne(accelerator: string, callback: () => void): { ok: boolean } {
    try {
      const ok = globalShortcut.register(accelerator, callback)
      if (!ok) logger.warn('shortcuts.register_failed', { accelerator })
      return { ok }
    } catch (error) {
      logger.warn('shortcuts.register_error', { accelerator, error })
      return { ok: false }
    }
  }

  private failure(
    desired: { toggle: string; capture: string },
    message: string
  ): ShortcutApplyResult {
    this.toggleStatus = {
      accelerator: desired.toggle,
      ok: false,
      error: message
    }
    this.captureStatus = {
      accelerator: desired.capture,
      ok: false,
      error: message
    }
    if (this.current) {
      this.toggleStatus = { accelerator: this.current.toggle, ok: true }
      this.captureStatus = { accelerator: this.current.capture, ok: true }
    }
    return {
      ok: false,
      toggle: this.toggleStatus,
      capture: this.captureStatus,
      error: message
    }
  }

  suspend(): void {
    this.suspended = true
    globalShortcut.unregisterAll()
  }

  resume(): void {
    this.suspended = false
    const desired = this.deferred ?? this.current
    if (!desired) return
    this.current = null
    this.apply({
      hotkeyToggle: desired.toggle,
      hotkeyCapture: desired.capture
    })
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll()
    this.current = null
  }
}
