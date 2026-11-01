/**
 * Tauri bridge for the FlowTray renderer.
 *
 * The React components were written against the Electron preload API
 * (`window.flowtray`). This module re-implements the exact same surface on top
 * of `invoke`/`listen`, so the UI code only needed changes where platform drag
 * and drop semantics differ.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { FlowTrayApi } from '@shared/api'
import type {
  AddPathsOptions,
  AddTextInput,
  DragEffect,
  DragOutPayload,
  E2EItemSpec,
  SettingsSection,
  ShelfSnapshot,
  UiCommand
} from '@shared/types'
import type { Settings } from '@shared/settings'

export interface NativeDropPayload {
  paths: string[]
  text: string
  html: string
  urls: string[]
  ctrl: boolean
  shift: boolean
  alt: boolean
  x: number
  y: number
}

function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null
  let cancelled = false
  void listen<T>(event, (message) => callback(message.payload)).then((dispose) => {
    if (cancelled) dispose()
    else unlisten = dispose
  })
  return () => {
    cancelled = true
    if (unlisten) unlisten()
  }
}

function toByteArray(data: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(data))
}

const api: FlowTrayApi = {
  app: {
    getSnapshot: () => invoke<ShelfSnapshot>('app_get_snapshot'),
    onSnapshot: (callback) => subscribe<ShelfSnapshot>('evt:snapshot', callback),
    onCommand: (callback) => subscribe<UiCommand>('evt:command', callback),
    foreground: () => invoke('app_foreground'),
    toggleWindow: () => invoke('app_toggle_window'),
    hideWindow: () => invoke('app_hide_window'),
    quit: () => invoke('app_quit'),
    restart: () => invoke('app_restart'),
    restartAsAdmin: () => invoke('app_restart_admin'),
    openDataDir: () => invoke('app_open_data_dir'),
    openLogsDir: () => invoke('app_open_logs_dir')
  },
  items: {
    addPaths: (paths: string[], options?: AddPathsOptions) =>
      invoke('items_add_paths', { payload: { paths, options } }),
    addText: (input: AddTextInput) => invoke('items_add_text', { payload: input }),
    addUrls: (urls: string[], sourceApp?: string | null) =>
      invoke('items_add_urls', { payload: { urls, sourceApp } }),
    addClipboard: () => invoke('items_add_clipboard'),
    addImageBuffer: (input) =>
      invoke('items_add_image', {
        payload: {
          data: toByteArray(input.data),
          mime: input.mime,
          name: input.name,
          sourceApp: input.sourceApp
        }
      }),
    update: (id, patch) => invoke('items_update', { payload: { id, patch } }),
    pin: (ids, pinned) => invoke('items_pin', { payload: { ids, pinned } }),
    remove: (ids) => invoke('items_remove', { payload: { ids } }),
    clear: (options) => invoke('items_clear', { payload: { includePinned: options?.includePinned } }),
    restoreUndo: () => invoke('items_undo'),
    copy: (ids, kind = 'auto') => invoke('items_copy', { payload: { ids, kind } }),
    openItem: (id) => invoke('items_open', { payload: { id } }),
    reveal: (id) => invoke('items_reveal', { payload: { id } }),
    relocate: (id) => invoke('items_relocate', { payload: { id } }),
    restoreOriginal: (id) => invoke('items_restore_original', { payload: { id } }),
    detail: (id) => invoke('items_detail', { payload: { id } }),
    startDrag: (payload: DragOutPayload) =>
      void invoke('items_start_drag', {
        payload: { ids: payload.ids, effect: payload.effect }
      }),
    dragEnded: (payload: { ids: string[]; effect: DragEffect }) => {
      void payload
    }
  },
  settings: {
    update: (patch: Partial<Settings>) => invoke('settings_update', { payload: { patch } }),
    reset: () => invoke('settings_reset'),
    exportConfig: () => invoke('settings_export'),
    chooseStorageDir: () => invoke('settings_choose_storage'),
    openStorageDir: () => invoke('settings_open_storage'),
    openDataDir: () => invoke('settings_open_data'),
    openLogsDir: () => invoke('settings_open_logs'),
    clearAllData: (includeSettings: boolean) =>
      invoke('settings_clear_data', { payload: { includeSettings } })
  },
  window: {
    resizeLive: (width, height) => void invoke('window_resize_live', { payload: { width, height } }),
    resizeEnd: () => void invoke('window_resize_end'),
    setInteractionLock: (locked) => void invoke('window_interaction_lock', { payload: { locked } }),
    hideReady: () => void invoke('window_hide_ready')
  },
  shortcuts: {
    suspend: () => invoke('shortcuts_suspend'),
    resume: () => invoke('shortcuts_resume')
  },
  getPathForFile: () => ''
}

api.__e2e = {
  seedItems: (specs: E2EItemSpec[]) => invoke('e2e_seed', { specs }),
  setSettings: (patch) => invoke('e2e_settings', { payload: { patch } }),
  openOnboarding: () => invoke('window_open_onboarding'),
  openSettings: (section?: SettingsSection) =>
    invoke('window_open_settings', { payload: { section } }),
  clearAll: async () => {
    await invoke('settings_clear_data', { payload: { includeSettings: false } })
  },
  sweep: () => invoke('e2e_sweep'),
  flush: () => invoke('e2e_flush')
}

export interface NativeDropHandlers {
  onEnter: (payload: NativeDropPayload) => void
  onOver: (payload: NativeDropPayload) => void
  onLeave: () => void
  onDrop: (payload: NativeDropPayload) => void
}

/** Subscribe to the native OLE drop target (replaces DOM drag events). */
export function onNativeDrop(handlers: NativeDropHandlers): () => void {
  const disposers = [
    subscribe<NativeDropPayload>('drop:enter', handlers.onEnter),
    subscribe<NativeDropPayload>('drop:over', handlers.onOver),
    subscribe<null>('drop:leave', () => handlers.onLeave()),
    subscribe<NativeDropPayload>('drop:drop', handlers.onDrop)
  ]
  return () => disposers.forEach((dispose) => dispose())
}

export interface FileDropHandlers {
  onEnter: () => void
  onOver: () => void
  onLeave: () => void
  onDrop: (paths: string[]) => void
}

/**
 * File/folder drag-in arrives through the WebView2 native drag-drop handler
 * configured by `dragDropEnabled`. Text and URL drags are handled by the
 * renderer's DOM fallback.
 */
export function onFileDrop(handlers: FileDropHandlers): () => void {
  let disposed = false
  let unlisten: UnlistenFn | null = null
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const payload = event.payload
      if (payload.type === 'enter' || payload.type === 'over') {
        if (payload.type === 'enter') handlers.onEnter()
        else handlers.onOver()
        return
      }
      if (payload.type === 'leave') {
        handlers.onLeave()
        return
      }
      if (payload.type === 'drop' && payload.paths.length > 0) {
        handlers.onDrop(payload.paths)
      }
    })
    .then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
  return () => {
    disposed = true
    if (unlisten) unlisten()
  }
}

export function installFlowTrayApi(): void {
  window.flowtray = api
}

export default api
