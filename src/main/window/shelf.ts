import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { GUTTER, isWindows11 } from '@main/lib/paths'
import { logger } from '@main/lib/logger'
import type { SettingsStore } from '@main/store/settings'
import type { UiCommand } from '@shared/types'

export type ShowReason = 'hotkey' | 'tray' | 'edge' | 'app' | 'ipc'

const VERTICAL_PADDING = 16
const HIDE_ANIMATION_MS = 130

export class ShelfWindow {
  private win: BrowserWindow | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private blurTimer: NodeJS.Timeout | null = null
  private queuedCommands: UiCommand[] = []
  private interactionLocked = false
  private quitting = false
  private lastShowAt = 0

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
      this.sendCommand({ type: 'blur' })
      if (this.settings.get().hideOnBlur) {
        if (this.blurTimer) clearTimeout(this.blurTimer)
        this.blurTimer = setTimeout(() => {
          if (!this.win || this.win.isDestroyed()) return
          if (this.win.isFocused() || this.interactionLocked) return
          this.hide()
        }, 160)
      }
    })
    win.on('focus', () => {
      if (this.blurTimer) {
        clearTimeout(this.blurTimer)
        this.blurTimer = null
      }
    })
    win.on('show', () => {
      this.lastShowAt = Date.now()
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
    }
    win.on('closed', onClosed)
    return win
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
    const settings = this.settings.get()
    if (process.platform === 'win32' && isWindows11() && settings.glass) {
      try {
        this.win.setBackgroundMaterial('acrylic')
        return
      } catch {
        // fall through
      }
    }
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
    this.positionAndSize('ipc')
  }

  show(reason: ShowReason, focus = true): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    this.positionAndSize(reason)
    if (win.isMinimized()) win.restore()
    if (focus && reason !== 'edge') {
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

  hide(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !win.isVisible()) return
    this.sendCommand({ type: 'window-will-hide' })
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      if (!win.isDestroyed()) win.hide()
    }, HIDE_ANIMATION_MS)
  }

  toggle(reason: ShowReason = 'hotkey'): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (win.isVisible()) {
      this.hide()
    } else {
      this.show(reason, true)
    }
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
    if (!this.win || this.win.isDestroyed()) return
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
    if (!bounds) {
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
