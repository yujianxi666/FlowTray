import { create } from 'zustand'
import type {
  DragEffect,
  SettingsSection,
  ShelfSnapshot,
  ToastTone
} from '@shared/types'

export type OverlayKind = 'none' | 'settings' | 'onboarding' | 'info'
export type ConfirmKind =
  | 'clear-shelf'
  | 'clear-data'
  | 'reset-data'
  | 'reset-settings'

export interface Toast {
  id: number
  tone: ToastTone
  message: string
}

export interface ContextMenuState {
  x: number
  y: number
  itemId: string
}

interface AppStore {
  snapshot: ShelfSnapshot | null
  loading: boolean
  windowVisible: boolean
  query: string
  typeFilter: 'all' | 'file' | 'image' | 'text' | 'url'
  onlyPinned: boolean
  onlyMissing: boolean
  selection: string[]
  anchorId: string | null
  overlay: OverlayKind
  infoId: string | null
  settingsSection: SettingsSection
  menu: ContextMenuState | null
  confirm: ConfirmKind | null
  toasts: Toast[]
  undoDismissedAt: number | null
  dragOut: { ids: string[]; effect: DragEffect } | null
  dropActive: boolean
  dropBusyLabel: string | null
  dropEffect: DragEffect
  settingsSaving: boolean

  setSnapshot: (snapshot: ShelfSnapshot) => void
  setLoading: (loading: boolean) => void
  setWindowVisible: (visible: boolean) => void
  setQuery: (query: string) => void
  setTypeFilter: (filter: AppStore['typeFilter']) => void
  toggleOnlyPinned: () => void
  toggleOnlyMissing: () => void
  selectOnly: (id: string) => void
  toggleSelect: (id: string) => void
  selectRange: (id: string, orderedIds: string[]) => void
  setSelection: (ids: string[]) => void
  clearSelection: () => void
  openSettings: (section?: SettingsSection) => void
  openOnboarding: () => void
  openInfo: (id: string) => void
  closeOverlay: () => void
  setSettingsSection: (section: SettingsSection) => void
  openMenu: (menu: ContextMenuState) => void
  closeMenu: () => void
  setConfirm: (confirm: ConfirmKind | null) => void
  pushToast: (message: string, tone?: ToastTone, duration?: number) => void
  dismissToast: (id: number) => void
  dismissUndo: () => void
  setDragOut: (dragOut: AppStore['dragOut']) => void
  setDropActive: (active: boolean) => void
  setDropBusyLabel: (label: string | null) => void
  setDropEffect: (effect: DragEffect) => void
  setSettingsSaving: (saving: boolean) => void
}

let toastId = 0

export const useAppStore = create<AppStore>((set, get) => ({
  snapshot: null,
  loading: true,
  windowVisible: true,
  query: '',
  typeFilter: 'all',
  onlyPinned: false,
  onlyMissing: false,
  selection: [],
  anchorId: null,
  overlay: 'none',
  infoId: null,
  settingsSection: 'general',
  menu: null,
  confirm: null,
  toasts: [],
  undoDismissedAt: null,
  dragOut: null,
  dropActive: false,
  dropBusyLabel: null,
  dropEffect: 'copy',
  settingsSaving: false,

  setSnapshot: (snapshot) =>
    set((state) => {
      const ids = new Set(snapshot.items.map((item) => item.id))
      return {
        snapshot,
        loading: false,
        selection: state.selection.filter((id) => ids.has(id)),
        infoId: state.infoId && ids.has(state.infoId) ? state.infoId : null,
        menu: state.menu && ids.has(state.menu.itemId) ? state.menu : null,
        undoDismissedAt:
          state.undoDismissedAt && snapshot.undo?.expiresAt === state.undoDismissedAt
            ? null
            : state.undoDismissedAt
      }
    }),

  setLoading: (loading) => set({ loading }),
  setWindowVisible: (windowVisible) => set({ windowVisible }),

  setQuery: (query) => set({ query, selection: [], anchorId: null }),
  setTypeFilter: (typeFilter) => set({ typeFilter, selection: [], anchorId: null }),
  toggleOnlyPinned: () =>
    set((state) => ({ onlyPinned: !state.onlyPinned, selection: [], anchorId: null })),
  toggleOnlyMissing: () =>
    set((state) => ({ onlyMissing: !state.onlyMissing, selection: [], anchorId: null })),

  selectOnly: (id) => set({ selection: [id], anchorId: id }),
  toggleSelect: (id) =>
    set((state) => {
      const exists = state.selection.includes(id)
      return {
        selection: exists
          ? state.selection.filter((entry) => entry !== id)
          : [...state.selection, id],
        anchorId: id
      }
    }),
  selectRange: (id, orderedIds) =>
    set((state) => {
      const anchor = state.anchorId ?? id
      const start = orderedIds.indexOf(anchor)
      const end = orderedIds.indexOf(id)
      if (start < 0 || end < 0) return { selection: [id], anchorId: id }
      const [from, to] = start <= end ? [start, end] : [end, start]
      return { selection: orderedIds.slice(from, to + 1), anchorId: anchor }
    }),
  setSelection: (selection) => set({ selection }),
  clearSelection: () => set({ selection: [], anchorId: null }),

  openSettings: (section) =>
    set((state) => ({
      overlay: 'settings',
      settingsSection: section ?? state.settingsSection,
      menu: null
    })),
  openOnboarding: () => set({ overlay: 'onboarding', menu: null, infoId: null }),
  openInfo: (id) => set({ overlay: 'info', infoId: id, menu: null }),
  closeOverlay: () => set({ overlay: 'none', infoId: null }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),

  openMenu: (menu) => set({ menu }),
  closeMenu: () => set({ menu: null }),
  setConfirm: (confirm) => set({ confirm, menu: null }),

  pushToast: (message, tone = 'info', duration = 4200) => {
    const id = ++toastId
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, tone, message }] }))
    if (duration > 0) {
      window.setTimeout(() => get().dismissToast(id), duration)
    }
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  dismissUndo: () =>
    set((state) => ({
      undoDismissedAt: state.snapshot?.undo?.expiresAt ?? Date.now()
    })),

  setDragOut: (dragOut) => set({ dragOut }),
  setDropActive: (dropActive) => set({ dropActive }),
  setDropBusyLabel: (dropBusyLabel) => set({ dropBusyLabel }),
  setDropEffect: (dropEffect) => set({ dropEffect }),
  setSettingsSaving: (settingsSaving) => set({ settingsSaving })
}))
