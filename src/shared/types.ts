/**
 * FlowTray shared domain types.
 * These types are used by the main process, preload bridge and renderer.
 */

import type { Settings } from './settings'

export const ITEM_TYPES = ['file', 'folder', 'image', 'text', 'url'] as const
export type ItemType = (typeof ITEM_TYPES)[number]

export const ITEM_STATUSES = ['active', 'missing', 'deleted', 'expired'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]

export type StorageMode = 'reference' | 'copy'
export type IngestEffect = 'copy' | 'cut'
export type DragEffect = 'copy' | 'cut'
export type TtlOption = '1h' | '24h' | '7d' | 'never'
export type ThemeMode = 'system' | 'dark' | 'light'
export type DockSide = 'left' | 'right'
export type DragModifier = 'ctrl' | 'shift' | 'alt'
export type ViewMode = 'list' | 'grid'
export type ItemSource = 'drop' | 'clipboard' | 'clipboard_auto' | 'manual'
export type SettingsSection =
  | 'general'
  | 'shelf'
  | 'storage'
  | 'drag'
  | 'privacy'
  | 'shortcuts'
  | 'about'

export type ErrorCode =
  | 'permission'
  | 'not_found'
  | 'disk_full'
  | 'unsupported'
  | 'too_large'
  | 'quota'
  | 'invalid'
  | 'sensitive'
  | 'clipboard_empty'
  | 'hotkey_conflict'
  | 'unknown'

export interface ItemError {
  code: ErrorCode
  message: string
  name?: string
}

/** The card-sized projection of an item. Full text is fetched on demand. */
export interface ShelfItemView {
  id: string
  type: ItemType
  name: string
  preview: string | null
  textContent: string | null
  textLength: number | null
  url: string | null
  path: string | null
  ext: string | null
  size: number
  sourceApp: string | null
  source: ItemSource
  createdAt: number
  expiresAt: number | null
  pinned: boolean
  status: ItemStatus
  storageMode: StorageMode
  hasThumb: boolean
  thumbUrl: string | null
  movedIn: boolean
  expiresInMs: number | null
  expiringSoon: boolean
}

export interface ShelfItemDetail extends ShelfItemView {
  textContent: string | null
  htmlContent: string | null
  originalPath: string | null
  hash: string | null
  lastCheckedAt: number | null
  meta: Record<string, unknown> | null
}

export interface StorageUsage {
  storedBytes: number
  referencedBytes: number
  capacityBytes: number
  itemCount: number
  pinnedCount: number
  missingCount: number
}

export interface HotkeyStatus {
  accelerator: string
  ok: boolean
  error?: string
}

export interface HostInfo {
  version: string
  runtimeVersion: string
  platform: string
  isPackaged: boolean
  isElevated: boolean
  supportsAcrylic: boolean
  dataPath: string
  storagePath: string
  logsPath: string
  autostartWarning: string | null
  hotkeys: {
    toggle: HotkeyStatus
    capture: HotkeyStatus
  }
}

export type UndoKind = 'clear' | 'delete' | 'expiry'

export interface UndoState {
  kind: UndoKind
  count: number
  expiresAt: number
  label: string
}

export type ToastTone = 'info' | 'success' | 'error'

export type UiCommand =
  | { type: 'open-settings'; section?: SettingsSection }
  | { type: 'open-onboarding' }
  | { type: 'open-clear-confirm' }
  | { type: 'focus-search' }
  | { type: 'toast'; tone: ToastTone; message: string }
  | { type: 'drag-out-start'; effect: DragEffect; count: number }
  | { type: 'drag-out-end'; effect: DragEffect; count: number }
  | { type: 'window-shown'; reason: 'hotkey' | 'tray' | 'edge' | 'app' | 'ipc' }
  | { type: 'window-will-hide' }
  | { type: 'items-expired'; count: number }
  | { type: 'blur' }

export interface ShelfSnapshot {
  revision: number
  items: ShelfItemView[]
  settings: Settings
  usage: StorageUsage
  host: HostInfo
  undo: UndoState | null
  now: number
}

export interface MutationResult {
  ok: boolean
  added: number
  duplicates: number
  errors: ItemError[]
  message?: string
  undo?: UndoState | null
}

export interface SettingsUpdateResult {
  ok: boolean
  errors: Array<{ field: string; message: string }>
}

export interface AddPathsOptions {
  effect?: IngestEffect
  sourceApp?: string | null
  source?: ItemSource
}

export interface AddTextInput {
  text: string
  html?: string | null
  sourceApp?: string | null
  source?: ItemSource
}

export interface DragOutPayload {
  ids: string[]
  effect: DragEffect
  iconDataUrl?: string | null
}

export interface E2EItemSpec {
  type: 'text' | 'url' | 'file' | 'image' | 'folder'
  text?: string
  url?: string
  path?: string
  name?: string
  pinned?: boolean
  expiresAt?: number | null
  sourceApp?: string | null
}
