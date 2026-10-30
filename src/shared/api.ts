import type {
  AddPathsOptions,
  DragEffect,
  DragOutPayload,
  ShelfItemDetail,
  MutationResult,
  SettingsUpdateResult,
  ShelfSnapshot,
  ToastTone,
  UiCommand,
  AddTextInput,
  SettingsSection,
  E2EItemSpec
} from './types'
import type { Settings } from './settings'

export interface CopyResult {
  ok: boolean
  message?: string
}

export interface ClearDataResult {
  ok: boolean
  message?: string
}

export interface ForegroundInfo {
  processName: string
  title: string
  appName: string
}

export interface FlowTrayApi {
  app: {
    getSnapshot(): Promise<ShelfSnapshot>
    onSnapshot(callback: (snapshot: ShelfSnapshot) => void): () => void
    onCommand(callback: (command: UiCommand) => void): () => void
    foreground(): Promise<ForegroundInfo | null>
    toggleWindow(): Promise<void>
    hideWindow(): Promise<void>
    quit(): Promise<void>
    restart(): Promise<void>
    restartAsAdmin(): Promise<void>
    openDataDir(): Promise<void>
    openLogsDir(): Promise<void>
  }
  items: {
    addPaths(paths: string[], options?: AddPathsOptions): Promise<MutationResult>
    addText(input: AddTextInput): Promise<MutationResult>
    addUrls(urls: string[], sourceApp?: string | null): Promise<MutationResult>
    addClipboard(): Promise<MutationResult>
    addImageBuffer(input: {
      data: ArrayBuffer
      mime: string
      name?: string
      sourceApp?: string | null
    }): Promise<MutationResult>
    update(id: string, patch: { pinned?: boolean; name?: string }): Promise<MutationResult>
    pin(ids: string[], pinned: boolean): Promise<MutationResult>
    remove(ids: string[]): Promise<MutationResult>
    clear(options?: { includePinned?: boolean }): Promise<MutationResult>
    restoreUndo(): Promise<MutationResult>
    copy(ids: string[], kind?: 'auto' | 'files' | 'path' | 'text'): Promise<CopyResult>
    openItem(id: string): Promise<CopyResult>
    reveal(id: string): Promise<CopyResult>
    relocate(id: string): Promise<MutationResult>
    restoreOriginal(id: string): Promise<MutationResult>
    detail(id: string): Promise<ShelfItemDetail | null>
    startDrag(payload: DragOutPayload): void
    dragEnded(payload: { ids: string[]; effect: DragEffect }): void
  }
  settings: {
    update(patch: Partial<Settings>): Promise<SettingsUpdateResult>
    reset(): Promise<SettingsUpdateResult>
    chooseStorageDir(): Promise<{ ok: boolean; message?: string; path?: string }>
    openStorageDir(): Promise<void>
    openDataDir(): Promise<void>
    openLogsDir(): Promise<void>
    clearAllData(includeSettings: boolean): Promise<ClearDataResult>
  }
  window: {
    resizeLive(width: number, height: number): void
    resizeEnd(): void
    setInteractionLock(locked: boolean): void
  }
  shortcuts: {
    suspend(): Promise<void>
    resume(): Promise<void>
  }
  getPathForFile(file: File): string
  toast?: (message: string, tone?: ToastTone) => void
  __e2e?: {
    seedItems(spec: E2EItemSpec[]): Promise<MutationResult>
    setSettings(patch: Partial<Settings>): Promise<SettingsUpdateResult>
    openOnboarding(): Promise<void>
    openSettings(section?: SettingsSection): Promise<void>
    clearAll(): Promise<void>
    sweep(): Promise<void>
    flush(): Promise<void>
  }
}
