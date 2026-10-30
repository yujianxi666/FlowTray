import {
  Notification,
  app,
  dialog,
  nativeTheme,
  shell
} from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { APP_VERSION } from '@shared/constants'
import type {
  AddPathsOptions,
  AddTextInput,
  DragEffect,
  DragOutPayload,
  E2EItemSpec,
  MutationResult,
  SettingsSection,
  SettingsUpdateResult,
  ShelfItemDetail,
  ShelfSnapshot,
  StorageUsage,
  ToastTone,
  UiCommand,
  UndoState
} from '@shared/types'
import type { SettingsPatch } from '@shared/settings'
import {
  appIconPath,
  dbFile,
  dragCacheDir,
  isWindows11,
  logsDir,
  userDataDir
} from '@main/lib/paths'
import {
  ensureDir,
  isPathInside,
  movePath,
  pathExists,
  removePath
} from '@main/lib/fs-utils'
import { logger } from '@main/lib/logger'
import type { Database } from '@main/store/db'
import { SettingsStore } from '@main/store/settings'
import { ItemService, normalizeUrl } from '@main/services/items'
import { ClipboardService } from '@main/services/clipboard'
import { DragService } from '@main/services/drag'
import { ShortcutManager } from '@main/services/shortcuts'
import { UndoManager } from '@main/services/undo'
import { Lifecycle } from '@main/services/lifecycle'
import { EdgeReveal } from '@main/services/edge-reveal'
import { TrayManager } from '@main/services/tray'
import { ShelfWindow } from '@main/window/shelf'
import {
  applyAutostart,
  getAutostartWarning,
  isElevated,
  restartAsAdmin
} from '@main/services/autostart'

export interface CopyResult {
  ok: boolean
  message?: string
}

export class AppController {
  readonly settings: SettingsStore
  readonly items: ItemService
  readonly shelf: ShelfWindow
  readonly tray: TrayManager
  readonly clipboard: ClipboardService
  readonly drag: DragService
  readonly shortcuts: ShortcutManager
  readonly undo: UndoManager
  readonly lifecycle: Lifecycle
  readonly edge: EdgeReveal

  private revision = 0
  private elevated = false
  private autostartWarning: string | null = null
  private broadcastTimer: NodeJS.Timeout | null = null
  private quitting = false
  private dbClosed = false
  private bootstrapped = false
  private lastUsage: StorageUsage = {
    storedBytes: 0,
    referencedBytes: 0,
    capacityBytes: 0,
    itemCount: 0,
    pinnedCount: 0,
    missingCount: 0
  }

  constructor(private readonly db: Database) {
    this.settings = new SettingsStore(db)
    this.items = new ItemService(db, this.settings, () => this.scheduleBroadcast())
    this.shelf = new ShelfWindow(this.settings)
    this.shortcuts = new ShortcutManager({
      onToggle: () => this.toggleShelf(),
      onCapture: () => {
        void this.captureFromHotkey()
      }
    })
    this.undo = new UndoManager(() => this.scheduleBroadcast())
    this.clipboard = new ClipboardService(this.items, this.settings)
    this.drag = new DragService(this.items, this.shelf, this.settings)
    this.lifecycle = new Lifecycle(this.items, this.drag, {
      onExpired: (ids) => this.handleExpired(ids),
      onRemind: (count) => this.handleRemind(count),
      onChange: () => this.scheduleBroadcast()
    })
    this.edge = new EdgeReveal(this.shelf, () => this.settings.get())
    this.tray = new TrayManager({
      onToggle: () => this.toggleShelf(),
      onShow: () => this.showShelf('tray'),
      onCapture: () => {
        void this.captureFromTray()
      },
      onClear: () => {
        this.showShelf('tray')
        this.shelf.sendCommand({ type: 'open-clear-confirm' })
      },
      onSettings: () => this.openSettings(),
      onOnboarding: () => this.openOnboarding(),
      onQuit: () => this.quit(),
      onToggleLaunchAtLogin: (enabled) => {
        void this.updateSettings({ launchAtLogin: enabled, launchAsAdmin: false }).then(
          (result) => {
            if (!result.ok) {
              this.showShelf('tray')
              this.toast('error', result.errors[0]?.message ?? '更新开机启动失败。')
            }
          }
        )
      }
    })
  }

  async bootstrap(): Promise<void> {
    this.elevated = await isElevated()
    nativeTheme.themeSource = this.settings.get().theme
    if (this.settings.get().clipboardMonitor) {
      await this.clipboard.startMonitoring()
    }
    const shortcutResult = this.shortcuts.apply(this.settings.get())
    if (!shortcutResult.ok && shortcutResult.error) {
      logger.warn('bootstrap.shortcut_unavailable', { error: shortcutResult.error })
    }
    await applyAutostart(this.settings.get())
    this.autostartWarning = await getAutostartWarning(this.settings.get())

    this.shelf.create()
    this.tray.create()
    this.edge.start()
    await this.lifecycle.boot()
    this.lifecycle.start()
    this.bootstrapped = true
    this.scheduleBroadcast()

    const settings = this.settings.get()
    if (!settings.onboardingDone || settings.openAtLaunch) {
      this.showShelf('app')
    }
    if (!settings.onboardingDone) {
      this.shelf.sendCommand({ type: 'open-onboarding' })
    }
  }

  isBootstrapped(): boolean {
    return this.bootstrapped
  }

  async getSnapshot(): Promise<ShelfSnapshot> {
    return this.buildSnapshot()
  }

  private buildSnapshot(): ShelfSnapshot {
    const now = Date.now()
    const settings = this.settings.get()
    const items = this.items.getItems(now)
    const usage = this.items.usage()
    this.lastUsage = usage
    this.revision += 1
    return {
      revision: this.revision,
      items,
      settings,
      usage,
      host: {
        version: app.isPackaged ? app.getVersion() : APP_VERSION,
        electronVersion: process.versions.electron,
        platform: process.platform,
        isPackaged: app.isPackaged,
        isElevated: this.elevated,
        supportsAcrylic: process.platform === 'win32' && isWindows11(),
        dataPath: userDataDir(),
        storagePath: this.items.storagePath(),
        logsPath: logsDir(),
        autostartWarning: this.autostartWarning,
        hotkeys: this.shortcuts.statuses()
      },
      undo: this.undo.getState(now),
      now
    }
  }

  scheduleBroadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      const snapshot = this.buildSnapshot()
      const window = this.shelf.window
      if (window && !window.isDestroyed()) {
        try {
          window.webContents.send('evt:snapshot', snapshot)
        } catch {
          // Renderer may be reloading.
        }
      }
      this.tray.update(
        snapshot.settings,
        snapshot.usage,
        this.shelf.isVisible()
      )
    }, 32)
  }

  showShelf(reason: 'hotkey' | 'tray' | 'edge' | 'app' | 'ipc' = 'ipc'): void {
    this.shelf.show(reason, reason !== 'edge')
    this.scheduleBroadcast()
    if (reason !== 'edge') {
      void this.lifecycle.verifyNow()
    }
  }

  hideShelf(): void {
    this.shelf.hide()
  }

  toggleShelf(): void {
    if (this.shelf.isVisible()) {
      this.shelf.hide()
    } else {
      this.showShelf('hotkey')
    }
  }

  openSettings(section?: SettingsSection): void {
    this.showShelf('ipc')
    this.shelf.sendCommand({ type: 'open-settings', section })
  }

  openOnboarding(): void {
    this.showShelf('ipc')
    this.shelf.sendCommand({ type: 'open-onboarding' })
  }

  sendCommand(command: UiCommand): void {
    this.shelf.sendCommand(command)
  }

  toast(tone: ToastTone, message: string): void {
    this.shelf.sendCommand({ type: 'toast', tone, message })
  }

  private handleExpired(ids: string[]): void {
    if (ids.length === 0) return
    this.undo.set('expiry', ids)
    if (!this.shelf.isVisible()) {
      this.notify('已自动清理到期内容', `${ids.length} 项临时内容已到期并移出暂存台。`)
    }
  }

  private handleRemind(count: number): void {
    if (count <= 0) return
    const message = `有 ${count} 项内容将在 15 分钟内到期。`
    if (this.shelf.isVisible()) {
      this.toast('info', message)
    } else {
      this.notify('FlowTray 到期提醒', `${message}固定后即可长期保留。`)
    }
  }

  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({
        title,
        body,
        icon: appIconPath(),
        silent: false
      })
      notification.on('click', () => this.showShelf('tray'))
      notification.show()
    } catch (error) {
      logger.debug('notification.failed', { error })
    }
  }

  async addPaths(paths: string[], options: AddPathsOptions = {}): Promise<MutationResult> {
    return this.items.addPaths(paths, options)
  }

  async addText(input: AddTextInput): Promise<MutationResult> {
    return this.items.addText(input)
  }

  async addUrls(urls: string[], sourceApp: string | null): Promise<MutationResult> {
    return this.items.addUrls(urls, { sourceApp, source: 'drop' })
  }

  async addImageBuffer(input: {
    data: ArrayBuffer
    mime: string
    name?: string
    sourceApp?: string | null
  }): Promise<MutationResult> {
    const buffer = Buffer.from(new Uint8Array(input.data))
    return this.items.addImageBuffer(buffer, {
      name: input.name,
      sourceApp: input.sourceApp ?? null,
      source: 'drop'
    })
  }

  async captureFromHotkey(): Promise<MutationResult> {
    const result = await this.clipboard.captureExplicit({ sourceFromForeground: true })
    this.showShelf('hotkey')
    this.reportClipboardResult(result)
    return result
  }

  async captureFromTray(): Promise<MutationResult> {
    const result = await this.clipboard.captureExplicit({ sourceFromForeground: true })
    this.showShelf('tray')
    this.reportClipboardResult(result)
    return result
  }

  async captureFromShelf(): Promise<MutationResult> {
    const result = await this.clipboard.captureExplicit({ sourceFromForeground: false })
    if (result.ok) {
      this.toast('success', this.resultMessage(result, '已从剪贴板暂存'))
    } else {
      this.toast('error', result.errors[0]?.message ?? '剪贴板里没有可暂存的内容。')
    }
    this.scheduleBroadcast()
    return result
  }

  private reportClipboardResult(result: MutationResult): void {
    if (result.ok) {
      this.toast('success', this.resultMessage(result, '已从剪贴板暂存'))
    } else {
      this.toast('error', result.errors[0]?.message ?? '剪贴板里没有可暂存的内容。')
    }
  }

  private resultMessage(result: MutationResult, prefix: string): string {
    if (result.added > 0) {
      return `${prefix} ${result.added} 项${result.duplicates > 0 ? `，${result.duplicates} 项已存在` : ''}。`
    }
    if (result.duplicates > 0) return '这些内容已在暂存台中，已为你置顶。'
    return prefix
  }

  async updateItem(
    id: string,
    patch: { pinned?: boolean; name?: string }
  ): Promise<MutationResult> {
    return this.items.update(id, patch)
  }

  async pinItems(ids: string[], pinned: boolean): Promise<MutationResult> {
    return this.items.setPinned(ids, pinned)
  }

  async removeItems(ids: string[]): Promise<MutationResult> {
    const existing = this.items.getCopyableRows(ids)
    const result = await this.items.remove(ids)
    if (existing.length > 0) {
      this.undo.set(
        'delete',
        existing.map((row) => row.id)
      )
    }
    return result
  }

  async clearItems(includePinned: boolean): Promise<MutationResult> {
    const { result, ids } = await this.items.clear(includePinned)
    if (ids.length > 0) {
      this.undo.set('clear', ids)
    }
    return result
  }

  async restoreUndo(): Promise<MutationResult> {
    const taken = this.undo.take()
    if (!taken) {
      return {
        ok: false,
        added: 0,
        duplicates: 0,
        errors: [{ code: 'invalid', message: '撤销窗口已过期。' }]
      }
    }
    const restored = await this.items.restore(taken.ids, taken.kind === 'expiry')
    return {
      ok: restored > 0,
      added: restored,
      duplicates: 0,
      errors:
        restored > 0
          ? []
          : [{ code: 'not_found', message: '这些内容已无法恢复。' }]
    }
  }

  getUndo(): UndoState | null {
    return this.undo.getState()
  }

  async copyItems(ids: string[], kind: 'auto' | 'files' | 'path' | 'text' = 'auto'): Promise<CopyResult> {
    const rows = this.items.getCopyableRows(ids)
    if (rows.length === 0) return { ok: false, message: '没有可复制的内容。' }
    const fileRows = rows.filter(
      (row) => row.type === 'file' || row.type === 'folder' || row.type === 'image'
    )

    try {
      if (kind === 'files') {
        const { paths, errors } = this.items.getExistingPaths(fileRows)
        if (paths.length === 0) {
          return { ok: false, message: errors[0]?.message ?? '文件已失效，无法复制。' }
        }
        await this.clipboard.copyFiles(paths)
        return {
          ok: true,
          message:
            paths.length > 1
              ? `已复制 ${paths.length} 个文件，可直接粘贴到资源管理器或聊天窗口。`
              : '已复制文件，可直接粘贴。'
        }
      }

      if (kind === 'path') {
        const lines = rows
          .map((row) => {
            const absolute = this.items.resolveItemPath(row)
            return absolute ?? row.url ?? row.text_content ?? ''
          })
          .filter(Boolean)
        if (lines.length === 0) return { ok: false, message: '没有可复制的路径。' }
        await this.clipboard.copyText(lines.join('\r\n'))
        return { ok: true, message: `已复制 ${lines.length} 条路径。` }
      }

      if (kind === 'text') {
        const texts = rows
          .filter((row) => row.type === 'text' || row.type === 'url')
          .map((row) => row.text_content ?? row.url ?? '')
          .filter(Boolean)
        if (texts.length === 0) return { ok: false, message: '选中的内容里没有文本。' }
        await this.clipboard.copyText(texts.join('\r\n\r\n'))
        return { ok: true, message: `已复制 ${texts.length} 条文本。` }
      }

      if (rows.length === 1) {
        const row = rows[0]
        if (row.type === 'text') {
          await this.clipboard.copyText(row.text_content ?? '', row.html_content)
          return { ok: true, message: '已复制文本，可直接粘贴。' }
        }
        if (row.type === 'url' && row.url) {
          await this.clipboard.copyBookmark(row.url, row.text_content ?? row.url)
          return { ok: true, message: '已复制链接。' }
        }
        if (row.type === 'image') {
          const absolute = this.items.resolveItemPath(row)
          if (absolute && pathExists(absolute)) {
            await this.clipboard.copyImage(await fs.readFile(absolute))
            return { ok: true, message: '已复制图片，可直接粘贴。' }
          }
        }
      }

      if (kind === 'auto' && fileRows.length === rows.length) {
        const { paths, errors } = this.items.getExistingPaths(fileRows)
        if (paths.length === 0) {
          return { ok: false, message: errors[0]?.message ?? '文件已失效，无法复制。' }
        }
        await this.clipboard.copyFiles(paths)
        return {
          ok: true,
          message:
            paths.length > 1
              ? `已复制 ${paths.length} 个文件，可直接粘贴到资源管理器或聊天窗口。`
              : '已复制文件，可直接粘贴。'
        }
      }

      const lines = rows.map((row) => {
        const absolute = this.items.resolveItemPath(row)
        return absolute ?? row.url ?? row.text_content ?? row.name
      })
      await this.clipboard.copyText(lines.join('\r\n'))
      return { ok: true, message: `已复制 ${rows.length} 项内容。` }
    } catch (error) {
      logger.warn('copy.failed', { error })
      return { ok: false, message: '复制失败，剪贴板可能正被其他程序占用。' }
    }
  }

  async openItem(id: string): Promise<CopyResult> {
    const detail = this.items.getDetail(id)
    if (!detail) return { ok: false, message: '这条内容已不在暂存台中。' }
    try {
      if (detail.type === 'url' && detail.url) {
        const normalized = normalizeUrl(detail.url)
        if (!normalized) return { ok: false, message: '链接格式无效，无法打开。' }
        await shell.openExternal(normalized)
        return { ok: true }
      }
      if (detail.type === 'text') {
        return { ok: false, message: '文本卡片请打开预览后复制。' }
      }
      if (!detail.path || !pathExists(detail.path)) {
        return { ok: false, message: '文件已失效或被移动，请重新定位。' }
      }
      const error = await shell.openPath(detail.path)
      if (error) {
        return { ok: false, message: '系统无法打开这个文件，可能缺少关联应用或权限不足。' }
      }
      return { ok: true }
    } catch (error) {
      logger.warn('open.failed', { error })
      return { ok: false, message: '打开失败，请检查文件权限。' }
    }
  }

  async revealItem(id: string): Promise<CopyResult> {
    const detail = this.items.getDetail(id)
    if (!detail || !detail.path) return { ok: false, message: '没有可定位的文件。' }
    if (!pathExists(detail.path)) {
      return { ok: false, message: '文件已失效或被移动，无法定位。' }
    }
    shell.showItemInFolder(detail.path)
    return { ok: true }
  }

  async getDetail(id: string): Promise<ShelfItemDetail | null> {
    return this.items.getDetail(id)
  }

  async relocateItem(id: string): Promise<MutationResult> {
    const detail = this.items.getDetail(id)
    if (!detail || (detail.type !== 'file' && detail.type !== 'folder' && detail.type !== 'image')) {
      return {
        ok: false,
        added: 0,
        duplicates: 0,
        errors: [{ code: 'invalid', message: '这条内容不支持重新定位。' }]
      }
    }
    const window = this.shelf.window
    const properties: Array<'openFile' | 'openDirectory'> =
      detail.type === 'folder' ? ['openDirectory'] : ['openFile']
    const options: Electron.OpenDialogOptions = {
      title: detail.type === 'folder' ? '选择文件夹的新位置' : '重新定位文件',
      properties,
      buttonLabel: '重新定位'
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return {
        ok: false,
        added: 0,
        duplicates: 0,
        errors: [{ code: 'invalid', message: '已取消重新定位。' }]
      }
    }
    return this.items.relocate(id, result.filePaths[0])
  }

  async restoreOriginal(id: string): Promise<MutationResult> {
    return this.items.restoreOriginal(id)
  }

  async startDrag(payload: DragOutPayload): Promise<void> {
    const ids = Array.isArray(payload.ids) ? payload.ids.filter(Boolean).slice(0, 200) : []
    const effect: DragEffect = payload.effect === 'cut' ? 'cut' : 'copy'
    await this.drag.startNativeDrag({
      ids,
      effect,
      iconDataUrl: payload.iconDataUrl ?? null
    })
  }

  onDragEnded(payload: { ids: string[]; effect: DragEffect }): void {
    if (payload.effect === 'cut') {
      setTimeout(() => {
        void this.items.markMovedOut(payload.ids)
      }, 900)
    }
  }

  async updateSettings(patch: SettingsPatch): Promise<SettingsUpdateResult> {
    if (Object.prototype.hasOwnProperty.call(patch, 'storageDir')) {
      return {
        ok: false,
        errors: [{ field: 'storageDir', message: '请使用“更改存储位置”来迁移数据。' }]
      }
    }
    const previous = this.settings.get()
    const touchesHotkeys =
      Object.prototype.hasOwnProperty.call(patch, 'hotkeyToggle') ||
      Object.prototype.hasOwnProperty.call(patch, 'hotkeyCapture')
    const draft = { ...previous, ...patch }
    if (draft.hotkeyToggle === draft.hotkeyCapture) {
      return {
        ok: false,
        errors: [{ field: 'hotkey', message: '两个快捷键不能相同。' }]
      }
    }
    if (patch.launchAsAdmin === true) {
      const elevated = await isElevated(true)
      this.elevated = elevated
      if (!elevated) {
        return {
          ok: false,
          errors: [
            {
              field: 'launchAsAdmin',
              message: '管理员自启动需要以管理员身份运行。请先使用“以管理员身份重启”。'
            }
          ]
        }
      }
    }

    let shortcutApplied = false
    if (touchesHotkeys) {
      const result = this.shortcuts.apply({
        hotkeyToggle: draft.hotkeyToggle,
        hotkeyCapture: draft.hotkeyCapture
      })
      if (!result.ok) {
        return {
          ok: false,
          errors: [{ field: 'hotkey', message: result.error ?? '快捷键注册失败。' }]
        }
      }
      shortcutApplied = true
    }

    const updated = this.settings.update(patch)
    if (!updated.ok) {
      if (shortcutApplied) this.shortcuts.apply(previous)
      return updated
    }
    const next = updated.settings

    if (
      Object.prototype.hasOwnProperty.call(patch, 'launchAtLogin') ||
      Object.prototype.hasOwnProperty.call(patch, 'launchAsAdmin')
    ) {
      const auto = await applyAutostart(next)
      if (!auto.ok) {
        this.settings.update({
          launchAtLogin: previous.launchAtLogin,
          launchAsAdmin: previous.launchAsAdmin
        })
        await applyAutostart(previous)
        this.autostartWarning = auto.warning ?? auto.error ?? null
        this.scheduleBroadcast()
        return {
          ok: false,
          errors: [
            {
              field: 'launchAsAdmin',
              message: auto.error ?? auto.warning ?? '设置开机启动失败。'
            }
          ]
        }
      }
    }
    if (patch.theme) nativeTheme.themeSource = patch.theme
    this.shelf.applySettings()
    if (
      Object.prototype.hasOwnProperty.call(patch, 'clipboardMonitor') ||
      Object.prototype.hasOwnProperty.call(patch, 'clipboardMaxItems')
    ) {
      if (next.clipboardMonitor) {
        await this.clipboard.startMonitoring()
      } else {
        this.clipboard.stopMonitoring()
      }
    }
    this.autostartWarning = await getAutostartWarning(next)
    this.scheduleBroadcast()
    return { ok: true, errors: [] }
  }

  async resetSettings(): Promise<SettingsUpdateResult> {
    const result = this.settings.reset()
    const next = result.settings
    const shortcutResult = this.shortcuts.apply(next)
    if (!shortcutResult.ok) {
      logger.warn('settings.reset_shortcut_failed', { error: shortcutResult.error })
    }
    await applyAutostart(next)
    this.autostartWarning = await getAutostartWarning(next)
    nativeTheme.themeSource = next.theme
    this.shelf.applySettings()
    if (next.clipboardMonitor) {
      await this.clipboard.startMonitoring()
    } else {
      this.clipboard.stopMonitoring()
    }
    this.scheduleBroadcast()
    return { ok: true, errors: [] }
  }

  async chooseStorageDir(): Promise<{ ok: boolean; message?: string; path?: string }> {
    const window = this.shelf.window
    const current = this.items.storagePath()
    const options: Electron.OpenDialogOptions = {
      title: '选择 FlowTray 的存储位置',
      buttonLabel: '使用此文件夹',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: '已取消。' }
    }
    const chosen = result.filePaths[0]
    if (chosen === current) return { ok: false, message: '这已经是当前存储位置。' }
    if (isPathInside(chosen, current) || isPathInside(current, chosen)) {
      return { ok: false, message: '不能选择当前存储位置的子目录或父目录。' }
    }
    try {
      await ensureDir(chosen)
      for (const name of ['files', 'thumbs']) {
        const target = join(chosen, name)
        if (pathExists(target)) {
          const entries = await fs.readdir(target)
          if (entries.length > 0) {
            return {
              ok: false,
              message: `目标文件夹中的 ${name} 目录非空，请选择一个空文件夹。`
            }
          }
        }
      }
      const probe = join(chosen, `.flowtray-write-test-${Date.now()}`)
      await fs.writeFile(probe, 'ok', 'utf8')
      await fs.unlink(probe)
      if (current !== chosen) {
        const wasMonitoring = this.clipboard.isMonitoring
        this.clipboard.stopMonitoring()
        const moved: Array<{ from: string; to: string }> = []
        try {
          for (const name of ['files', 'thumbs']) {
            const from = join(current, name)
            const to = join(chosen, name)
            if (pathExists(from)) {
              if (pathExists(to)) await removePath(to)
              await movePath(from, to, true)
              moved.push({ from, to })
            } else {
              await ensureDir(to)
            }
          }
        } catch (error) {
          for (const item of moved.reverse()) {
            try {
              await movePath(item.to, item.from, true)
            } catch {
              // Best effort rollback.
            }
          }
          if (wasMonitoring) await this.clipboard.startMonitoring()
          logger.warn('storage.migrate_failed', { error })
          return { ok: false, message: '迁移失败，已尽量恢复原位置。请检查磁盘空间与权限。' }
        }
        this.settings.setStorageDir(chosen)
        await this.items.ensureLayout()
        if (wasMonitoring) await this.clipboard.startMonitoring()
      } else {
        this.settings.setStorageDir(chosen)
      }
      this.scheduleBroadcast()
      return { ok: true, message: '存储位置已更新。', path: chosen }
    } catch (error) {
      logger.warn('storage.choose_failed', { error })
      return { ok: false, message: '无法使用这个文件夹，请检查写入权限。' }
    }
  }

  async openStorageDir(): Promise<void> {
    await ensureDir(this.items.storagePath())
    await shell.openPath(this.items.storagePath())
  }

  async openDataDir(): Promise<void> {
    await ensureDir(userDataDir())
    await shell.openPath(userDataDir())
  }

  async openLogsDir(): Promise<void> {
    await ensureDir(logsDir())
    await shell.openPath(logsDir())
  }

  async clearAllData(includeSettings: boolean): Promise<{ ok: boolean; message?: string }> {
    this.clipboard.stopMonitoring()
    this.lifecycle.stop()
    this.edge.stop()
    this.shortcuts.unregisterAll()
    this.undo.clear()
    try {
      this.db.run('DELETE FROM items')
      await removePath(this.items.filesPath())
      await removePath(this.items.thumbsPath())
      await removePath(dragCacheDir())
      await ensureDir(this.items.filesPath())
      await ensureDir(this.items.thumbsPath())
      if (includeSettings) {
        this.db.run('DELETE FROM settings')
      }
      this.db.close()
      this.dbClosed = true
      if (includeSettings) {
        await removePath(logsDir())
        await removePath(dbFile())
        await removePath(`${dbFile()}-wal`)
        await removePath(`${dbFile()}-shm`)
      }
      logger.info('data.cleared', { includeSettings })
      this.shelf.markQuitting()
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 350)
      return { ok: true, message: '本地数据已清除，FlowTray 将重新启动。' }
    } catch (error) {
      logger.warn('data.clear_failed', { error })
      return { ok: false, message: '清除数据失败，请关闭应用后手动删除数据目录。' }
    }
  }

  async suspendShortcuts(): Promise<void> {
    this.shortcuts.suspend()
  }

  async resumeShortcuts(): Promise<void> {
    this.shortcuts.resume()
    this.scheduleBroadcast()
  }

  commitWindowSize(): void {
    const size = this.shelf.getCardSize()
    this.settings.update({ shelfWidth: size.width, shelfHeight: size.height })
    this.scheduleBroadcast()
  }

  async seedE2E(specs: E2EItemSpec[]): Promise<MutationResult> {
    const combined: MutationResult = {
      ok: true,
      added: 0,
      duplicates: 0,
      errors: []
    }
    for (const spec of specs) {
      let result: MutationResult | null = null
      if (spec.type === 'text' && spec.text) {
        result = await this.items.addText({
          text: spec.text,
          sourceApp: spec.sourceApp ?? 'E2E',
          source: 'manual'
        })
      } else if (spec.type === 'url' && spec.url) {
        result = await this.items.addUrls([spec.url], {
          sourceApp: spec.sourceApp ?? 'E2E',
          source: 'manual'
        })
      } else if (spec.path) {
        result = await this.items.addPaths([spec.path], {
          sourceApp: spec.sourceApp ?? 'E2E',
          source: 'drop',
          effect: 'copy'
        })
      }
      if (!result) continue
      combined.added += result.added
      combined.duplicates += result.duplicates
      combined.errors.push(...result.errors)
      const latest = this.db.get<{ id: string }>(
        'SELECT id FROM items WHERE status IN (\'active\', \'missing\') ORDER BY created_at DESC, sort_order DESC LIMIT 1'
      )
      if (latest) {
        if (spec.name) {
          this.db.run('UPDATE items SET name = ? WHERE id = ?', spec.name, latest.id)
        }
        if (spec.pinned) {
          await this.items.update(latest.id, { pinned: true })
        }
        if (spec.expiresAt !== undefined) {
          this.db.run('UPDATE items SET expires_at = ? WHERE id = ?', spec.expiresAt, latest.id)
        }
      }
    }
    this.scheduleBroadcast()
    return combined
  }

  openOnboardingE2E(): void {
    this.openOnboarding()
  }

  openSettingsE2E(section?: SettingsSection): void {
    this.openSettings(section)
  }

  async runLifecycleForE2E(): Promise<void> {
    await this.lifecycle.tick()
    this.scheduleBroadcast()
  }

  async restart(): Promise<void> {
    this.shelf.markQuitting()
    app.relaunch()
    app.exit(0)
  }

  async restartAdmin(): Promise<void> {
    try {
      await restartAsAdmin()
      this.shelf.markQuitting()
      setTimeout(() => app.exit(0), 350)
    } catch {
      this.toast('error', '请求管理员权限失败。你可以右键 FlowTray 图标，选择“以管理员身份运行”。')
    }
  }

  quit(): void {
    this.quitting = true
    this.shelf.markQuitting()
    app.quit()
  }

  shutdown(): void {
    this.lifecycle.stop()
    this.edge.stop()
    this.clipboard.stopMonitoring()
    this.shortcuts.unregisterAll()
    this.tray.destroy()
    if (!this.dbClosed) {
      this.db.close()
      this.dbClosed = true
    }
  }

  isQuitting(): boolean {
    return this.quitting
  }
}
