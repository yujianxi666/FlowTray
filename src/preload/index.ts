import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '@shared/ipc'
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

const api: FlowTrayApi = {
  app: {
    getSnapshot: () => ipcRenderer.invoke(IPC.snapshotGet) as Promise<ShelfSnapshot>,
    onSnapshot: (callback) => {
      const listener = (_event: unknown, snapshot: ShelfSnapshot): void => callback(snapshot)
      ipcRenderer.on(IPC.snapshotEvent, listener)
      return () => ipcRenderer.removeListener(IPC.snapshotEvent, listener)
    },
    onCommand: (callback) => {
      const listener = (_event: unknown, command: UiCommand): void => callback(command)
      ipcRenderer.on(IPC.commandEvent, listener)
      return () => ipcRenderer.removeListener(IPC.commandEvent, listener)
    },
    foreground: () => ipcRenderer.invoke(IPC.foreground),
    toggleWindow: () => ipcRenderer.invoke(IPC.windowToggle),
    hideWindow: () => ipcRenderer.invoke(IPC.windowHide),
    quit: () => ipcRenderer.invoke(IPC.quit),
    restart: () => ipcRenderer.invoke(IPC.restart),
    restartAsAdmin: () => ipcRenderer.invoke(IPC.restartAdmin),
    openDataDir: () => ipcRenderer.invoke(IPC.openDataDir),
    openLogsDir: () => ipcRenderer.invoke(IPC.openLogsDir)
  },
  items: {
    addPaths: (paths: string[], options?: AddPathsOptions) =>
      ipcRenderer.invoke(IPC.itemsAddPaths, { paths, options }),
    addText: (input: AddTextInput) => ipcRenderer.invoke(IPC.itemsAddText, input),
    addUrls: (urls: string[], sourceApp?: string | null) =>
      ipcRenderer.invoke(IPC.itemsAddUrls, { urls, sourceApp }),
    addClipboard: () => ipcRenderer.invoke(IPC.itemsAddClipboard),
    addImageBuffer: (input) => ipcRenderer.invoke(IPC.itemsAddImageBuffer, input),
    update: (id, patch) => ipcRenderer.invoke(IPC.itemsUpdate, { id, patch }),
    pin: (ids, pinned) => ipcRenderer.invoke(IPC.itemsPin, { ids, pinned }),
    remove: (ids) => ipcRenderer.invoke(IPC.itemsRemove, { ids }),
    clear: (options) => ipcRenderer.invoke(IPC.itemsClear, options ?? {}),
    restoreUndo: () => ipcRenderer.invoke(IPC.itemsUndo),
    copy: (ids, kind = 'auto') => ipcRenderer.invoke(IPC.itemsCopy, { ids, kind }),
    openItem: (id) => ipcRenderer.invoke(IPC.itemsOpen, { id }),
    reveal: (id) => ipcRenderer.invoke(IPC.itemsReveal, { id }),
    relocate: (id) => ipcRenderer.invoke(IPC.itemsRelocate, { id }),
    restoreOriginal: (id) => ipcRenderer.invoke(IPC.itemsRestoreOriginal, { id }),
    detail: (id) => ipcRenderer.invoke(IPC.itemsDetail, { id }),
    startDrag: (payload: DragOutPayload) => ipcRenderer.send(IPC.itemsStartDrag, payload),
    dragEnded: (payload: { ids: string[]; effect: DragEffect }) =>
      ipcRenderer.send(IPC.itemsDragEnded, payload)
  },
  settings: {
    update: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    reset: () => ipcRenderer.invoke(IPC.settingsReset),
    chooseStorageDir: () => ipcRenderer.invoke(IPC.settingsChooseStorage),
    openStorageDir: () => ipcRenderer.invoke(IPC.settingsOpenStorage),
    openDataDir: () => ipcRenderer.invoke(IPC.openDataDir),
    openLogsDir: () => ipcRenderer.invoke(IPC.openLogsDir),
    clearAllData: (includeSettings: boolean) =>
      ipcRenderer.invoke(IPC.settingsClearData, { includeSettings })
  },
  window: {
    resizeLive: (width, height) => ipcRenderer.send(IPC.windowResizeLive, { width, height }),
    resizeEnd: () => ipcRenderer.send(IPC.windowResizeEnd),
    setInteractionLock: (locked) => ipcRenderer.send(IPC.windowInteractionLock, locked)
  },
  shortcuts: {
    suspend: () => ipcRenderer.invoke(IPC.shortcutsSuspend),
    resume: () => ipcRenderer.invoke(IPC.shortcutsResume)
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file)
}

const e2eEnabled = (() => {
  try {
    return ipcRenderer.sendSync(IPC.e2eFlag) === true
  } catch {
    return false
  }
})()

if (e2eEnabled) {
  api.__e2e = {
    seedItems: (specs: E2EItemSpec[]) => ipcRenderer.invoke(IPC.e2eSeed, specs),
    setSettings: (patch) => ipcRenderer.invoke(IPC.e2eSettings, patch),
    openOnboarding: () => ipcRenderer.invoke(IPC.e2eOpenOnboarding),
    openSettings: (section?: SettingsSection) =>
      ipcRenderer.invoke(IPC.e2eOpenSettings, { section }),
    clearAll: () => ipcRenderer.invoke(IPC.e2eClearAll),
    sweep: () => ipcRenderer.invoke(IPC.e2eSweep),
    flush: () => ipcRenderer.invoke(IPC.e2eFlush)
  }
}

contextBridge.exposeInMainWorld('flowtray', api)
