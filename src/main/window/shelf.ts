import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { GUTTER } from '@main/lib/paths'
import { logger } from '@main/lib/logger'
import type { SettingsStore } from '@main/store/settings'
import type { UiCommand } from '@shared/types'

export type ShowReason = 'hotkey' | 'tray' | 'edge' | 'app' | 'ipc'

const VERTICAL_PADDING = 0
const HIDE_ANIMATION_MS = 200
const PEEK_WIDTH = 32
const PEEK_HEIGHT = 180
type WindowMode = 'hidden' | 'full' | 'peek'

export class ShelfWindow {
  private win: BrowserWindow | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private blurTimer: NodeJS.Timeout | null = null
  private focusWatch: NodeJS.Timeout | null = null
  private queuedCommands: UiCommand[] = []
  private interactionLocked = false
  private quitting = false
  private lastShowAt = 0
  private shownFocused = false
  private lastFocusAt = 0
  private lastBlurAt = 0
  private edgeGraceUntil = 0
  private mode: WindowMode = 'hidden'

  constructor(private readonly settings: SettingsStore) {}

  get window(): BrowserWindow | null {
    return this.win
  }

  create(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const settings = this.settings.get()
    const preload = join(__dirname, '../preload/index.js')
    const win = new BrowserWindow({
      width: this.windowWidth(),
      height: this.windowHeight(),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: settings.alwaysOnTop,
      title: 'FlowTray 流转台',
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: !process.env.FLOWTRAY_E2E,
        zoomFactor: 1
      }
    })
    this.win = win
    this.applyBackgroundMaterial()
    win.setIgnoreMouseEvents(false)
    win.setFocusable(true)
    this.positionAndSize('app')
    win.setMenuBarVisibility(false)
    win.setAlwaysOnTop(settings.alwaysOnTop, 'floating')

    win.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault()
        this.hide()
      }
    })
    win.on('blur', () => {
      this.lastBlurAt = Date.now()
      this.sendCommand({ type: 'blur' })
      if (!this.settings.get().hideOnBlur || this.mode !== 'full') return
      if (this.blurTimer) clearTimeout(this.blurTimer)
      this.blurTimer = setTimeout(() => {
        if (!this.win || this.win.isDestroyed()) return
        if (!this.win.isVisible() || this.interactionLocked) return
        if (!this.settings.get().hideOnBlur) return
        // Do not re-check isFocused here: on Windows that flag can remain true
        // for a frame after focus has already moved to another process. A real
        // focus event clears this timer, so the event itself is authoritative.
        this.hide()
      }, 220)
    })
    win.on('focus', () => {
      this.shownFocused = true
      this.lastFocusAt = Date.now()
      this.lastBlurAt = 0
      if (this.blurTimer) {
        clearTimeout(this.blurTimer)
        this.blurTimer = null
      }
    })
    win.on('show', () => {
      this.lastShowAt = Date.now()
    })
    win.on('hide', () => {
      this.shownFocused = false
      this.mode = 'hidden'
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event) => {
      event.preventDefault()
    })
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      const devtoolsCombo = input.control && input.shift && key === 'i'
      if (devtoolsCombo || key === 'f12') {
        if (!process.env.FLOWTRAY_E2E) {
          event.preventDefault()
          if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
            win.webContents.toggleDevTools()
          }
        }
        return
      }
      if (!win.webContents.isDevToolsOpened() && input.control && key === 'r') {
        event.preventDefault()
      }
    })
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })

    win.webContents.on('did-finish-load', () => {
      const pending = this.queuedCommands.splice(0)
      for (const command of pending) this.sendCommand(command)
    })

    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    if (rendererUrl) {
      void win.loadURL(rendererUrl)
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'))
    }

    const onClosed = (): void => {
      this.win = null
      if (this.focusWatch) {
        clearInterval(this.focusWatch)
        this.focusWatch = null
      }
    }
    win.on('closed', onClosed)
    this.startFocusWatch()
    return win
  }

  private startFocusWatch(): void {
    if (this.focusWatch) return
    this.focusWatch = setInterval(() => {
      const win = this.win
      if (!win || win.isDestroyed() || !win.isVisible()) return
      if (this.mode !== 'full') return
      if (!this.settings.get().hideOnBlur) return
      if (!this.shownFocused || this.interactionLocked) return
      if (Date.now() < this.edgeGraceUntil) return
      if (Date.now() - this.lastShowAt < 700) return
      if (this.lastBlurAt > this.lastFocusAt) {
        if (Date.now() - this.lastBlurAt < 500) return
        this.hide()
        return
      }
      // Fallback when the OS did not deliver a blur event at all: trust the
      // focused state once the window has been unfocused for a full second.
      if (win.isFocused()) return
      if (Date.now() - this.lastFocusAt < 1200) return
      this.hide()
    }, 600)
  }

  private windowWidth(): number {
    return this.clampCardWidth(this.settings.get().shelfWidth) + GUTTER
  }

  private windowHeight(): number {
    return this.clampCardHeight(this.settings.get().shelfHeight) + VERTICAL_PADDING
  }

  private clampCardWidth(value: number): number {
    return Math.max(340, Math.min(560, Math.round(value)))
  }

  private clampCardHeight(value: number): number {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const max = Math.max(480, display.workArea.height - 32)
    return Math.max(480, Math.min(Math.min(1000, max), Math.round(value)))
  }

  private targetDisplay(): Electron.Display {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  }

  private positionAndSize(reason: ShowReason): void {
    if (!this.win || this.win.isDestroyed()) return
    const display = this.targetDisplay()
    const settings = this.settings.get()
    const width = this.windowWidth()
    const height = this.windowHeight()
    const work = display.workArea
    const x =
      settings.shelfSide === 'right'
        ? work.x + work.width - width
        : work.x
    const y = work.y + Math.max(8, Math.round((work.height - height) / 2))
    try {
      this.win.setBounds({ x: Math.round(x), y: Math.round(y), width, height })
    } catch (error) {
      logger.debug('window.position_failed', { error, reason })
    }
  }

  private applyBackgroundMaterial(): void {
    if (!this.win || this.win.isDestroyed()) return
    // The transparent-window + OS acrylic combination paints the entire
    // rectangular window (including the old shadow gutter) as a dark frame on
    // some Windows 11 builds. The shelf now uses CSS translucency only.
    try {
      this.win.setBackgroundMaterial('none')
    } catch {
      // ignore
    }
  }

  applySettings(): void {
    if (!this.win || this.win.isDestroyed()) return
    const settings = this.settings.get()
    this.win.setAlwaysOnTop(settings.alwaysOnTop, 'floating')
    this.applyBackgroundMaterial()
    if (this.mode === 'peek') {
      const point = screen.getCursorScreenPoint()
      this.showPeek(point, screen.getDisplayNearestPoint(point))
      return
    }
    if (this.mode === 'full') this.positionAndSize('ipc')
  }

  show(reason: ShowReason, focus = true): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    if (this.mode === 'peek') {
      win.setIgnoreMouseEvents(false)
      win.setFocusable(true)
    }
    this.mode = 'full'
    this.edgeGraceUntil = reason === 'edge' ? Date.now() + 2500 : 0
    this.positionAndSize(reason)
    if (win.isMinimized()) win.restore()
    this.shownFocused = focus
    if (focus) {
      this.lastFocusAt = Date.now()
      win.show()
      win.moveTop()
      win.focus()
    } else {
      win.showInactive()
      win.moveTop()
    }
    win.setAlwaysOnTop(this.settings.get().alwaysOnTop, 'floating')
    const command: UiCommand = { type: 'window-shown', reason }
    if (win.webContents.isLoadingMainFrame()) {
      this.queuedCommands.push(command)
    } else {
      setTimeout(() => this.sendCommand(command), 16)
    }
  }

  showPeek(point: Electron.Point, display: Electron.Display): void {
    const win = this.win
    if (!win || win.isDestroyed() || this.quitting || this.mode === 'full') return
    const area = display.workArea
    const height = Math.min(PEEK_HEIGHT, Math.max(120, area.height - 24))
    const width = PEEK_WIDTH
    const y = Math.max(
      area.y + 8,
      Math.min(area.y + area.height - height - 8, Math.round(point.y - height / 2))
    )
    const x =
      this.settings.get().shelfSide === 'right'
        ? area.x + area.width - width
        : area.x
    this.mode = 'peek'
    win.setFocusable(false)
    win.setIgnoreMouseEvents(true)
    win.setBounds({ x: Math.round(x), y, width, height })
    win.setAlwaysOnTop(true, 'floating')
    if (!win.isVisible()) {
      win.showInactive()
    }
    win.moveTop()
  }

  hidePeek(): void {
    const win = this.win
    if (this.mode !== 'peek') return
    this.mode = 'hidden'
    if (win && !win.isDestroyed()) {
      win.hide()
      win.setIgnoreMouseEvents(false)
      win.setFocusable(true)
    }
  }

  hide(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !win.isVisible()) return
    if (this.mode === 'peek') {
      this.hidePeek()
      return
    }
    this.sendCommand({ type: 'window-will-hide' })
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      if (!win.isDestroyed()) {
        win.hide()
        win.setIgnoreMouseEvents(false)
        win.setFocusable(true)
      }
    }, HIDE_ANIMATION_MS)
  }

  toggle(reason: ShowReason = 'hotkey'): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (this.mode === 'full' && win.isVisible()) {
      this.hide()
    } else {
      this.show(reason, true)
    }
  }

  isFullVisible(): boolean {
    return Boolean(
      this.win &&
        !this.win.isDestroyed() &&
        this.win.isVisible() &&
        this.mode === 'full'
    )
  }

  isPeeking(): boolean {
    return Boolean(
      this.win && !this.win.isDestroyed() && this.win.isVisible() && this.mode === 'peek'
    )
  }

  sendCommand(command: UiCommand): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (win.webContents.isLoadingMainFrame()) {
      this.queuedCommands.push(command)
      if (this.queuedCommands.length > 30) this.queuedCommands.shift()
      return
    }
    try {
      win.webContents.send('evt:command', command)
    } catch {
      // The renderer may still be tearing down.
    }
  }

  setInteractionLocked(locked: boolean): void {
    this.interactionLocked = locked
  }

  setSizeLive(width: number, height: number): void {
    if (!this.win || this.win.isDestroyed() || this.mode !== 'full') return
    const display = this.targetDisplay()
    const work = display.workArea
    const cardWidth = this.clampCardWidth(width)
    const cardHeight = Math.max(
      480,
      Math.min(Math.min(1000, work.height - 32), Math.round(height))
    )
    const windowWidth = cardWidth + GUTTER
    const windowHeight = cardHeight + VERTICAL_PADDING
    const bounds = this.win.getBounds()
    const settings = this.settings.get()
    const x =
      settings.shelfSide === 'right'
        ? work.x + work.width - windowWidth
        : work.x
    try {
      this.win.setBounds({
        x: Math.round(x),
        y: bounds.y,
        width: windowWidth,
        height: windowHeight
      })
    } catch {
      // ignore transient resize errors
    }
  }

  getCardSize(): { width: number; height: number } {
    const bounds = this.win?.getBounds()
    if (!bounds || bounds.width < 80) {
      return {
        width: this.settings.get().shelfWidth,
        height: this.settings.get().shelfHeight
      }
    }
    return {
      width: Math.max(340, bounds.width - GUTTER),
      height: Math.max(480, bounds.height - VERTICAL_PADDING)
    }
  }

  isVisible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible())
  }

  getLastShowAt(): number {
    return this.lastShowAt
  }

  markQuitting(): void {
    this.quitting = true
  }
}
