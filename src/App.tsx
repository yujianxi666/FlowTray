import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Move } from 'lucide-react'
import type { DragEffect, MutationResult, ShelfItemView, ToastTone, UiCommand } from '@shared/types'
import { useAppStore } from './store'
import { Header } from './components/Header'
import { SearchFilter, type Counts } from './components/SearchFilter'
import { ItemList } from './components/ItemList'
import { EmptyState } from './components/EmptyState'
import { EdgePeek } from './components/EdgePeek'
import { Footer } from './components/Footer'
import { SelectionBar } from './components/SelectionBar'
import { ToastHost } from './components/ToastHost'
import { DropOverlay } from './components/DropOverlay'
import { ResizeHandles } from './components/ResizeHandles'
import { Onboarding } from './components/Onboarding'
import { InfoSheet } from './components/InfoSheet'
import { ContextMenu } from './components/ContextMenu'
import { ConfirmDialog } from './components/ConfirmDialog'
import { BrandMark } from './components/ui'
import {
  cx,
  invertedEffect,
  itemTypeMatches,
  matchesQuery,
  modifierPressed
} from './lib/utils'
import { applyThemeVariables, resolveThemeColors } from './lib/theme'
import { onFileDrop, onNativeDrop, type NativeDropPayload } from './api'

const SettingsPanel = lazy(() =>
  import('./components/SettingsPanel').then((module) => ({ default: module.SettingsPanel }))
)

export default function App() {
  const snapshot = useAppStore((state) => state.snapshot)
  const query = useAppStore((state) => state.query)
  const typeFilter = useAppStore((state) => state.typeFilter)
  const onlyPinned = useAppStore((state) => state.onlyPinned)
  const onlyMissing = useAppStore((state) => state.onlyMissing)
  const selection = useAppStore((state) => state.selection)
  const overlay = useAppStore((state) => state.overlay)
  const windowVisible = useAppStore((state) => state.windowVisible)
  const menu = useAppStore((state) => state.menu)
  const dragOut = useAppStore((state) => state.dragOut)
  const confirm = useAppStore((state) => state.confirm)
  const openOnboarding = useAppStore((state) => state.openOnboarding)
  const openSettings = useAppStore((state) => state.openSettings)
  const searchRef = useRef<HTMLInputElement>(null)
  const internalDragRef = useRef(false)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  const [entering, setEntering] = useState(true)
  const [pre, setPre] = useState(false)
  const [, setClock] = useState(0)
  const initialHandled = useRef(false)
  const enteringTimer = useRef<number | null>(null)
  const hideTimer = useRef<number | null>(null)
  const visibleRef = useRef<ShelfItemView[]>([])
  const selectionRef = useRef<string[]>([])

  const items = snapshot?.items ?? []
  const settings = snapshot?.settings
  const host = snapshot?.host

  const clipboardItems = useMemo(
    () => items.filter((item) => item.source === 'clipboard_auto'),
    [items]
  )
  // Items that came in as the contents of a dropped folder are grouped into a
  // collection card, exactly like the clipboard collection.
  const folderGroups = useMemo(() => {
    const map = new Map<string, ShelfItemView[]>()
    for (const item of items) {
      const source = item.source ?? ''
      if (!source.startsWith('folder:')) continue
      const label = source.slice('folder:'.length)
      const bucket = map.get(label) ?? []
      bucket.push(item)
      map.set(label, bucket)
    }
    return [...map.entries()].map(([label, entries]) => ({
      label,
      items: entries,
      count: entries.length
    }))
  }, [items])
  const folderGroup = useAppStore((state) => state.folderGroup)
  const activeFolder = folderGroups.find((group) => group.label === folderGroup) ?? null
  // When the clipboard collection is enabled it keeps its own tab; every other
  // filter works on the remaining items so a big paste never floods the list.
  const scopedItems = useMemo(() => {
    if (activeFolder) return activeFolder.items
    const base = settings?.clipboardSeparate
      ? items.filter((item) => item.source !== 'clipboard_auto')
      : items
    // Folder contents stay inside their collection card until it is opened.
    return base.filter((item) => !(item.source ?? '').startsWith('folder:'))
  }, [items, settings?.clipboardSeparate, activeFolder])

  const counts: Counts = useMemo(
    () => ({
      all: scopedItems.length,
      file: scopedItems.filter((item) => item.type === 'file' || item.type === 'folder').length,
      image: scopedItems.filter((item) => item.type === 'image').length,
      text: scopedItems.filter((item) => item.type === 'text').length,
      url: scopedItems.filter((item) => item.type === 'url').length,
      pinned: scopedItems.filter((item) => item.pinned).length,
      missing: scopedItems.filter((item) => item.status === 'missing').length,
      clipboard: clipboardItems.length
    }),
    [scopedItems, clipboardItems]
  )

  const visible = useMemo(() => {
    const pool = typeFilter === 'clipboard' ? clipboardItems : scopedItems
    return pool.filter((item) => {
      if (typeFilter !== 'clipboard' && !itemTypeMatches(item, typeFilter)) return false
      if (onlyPinned && !item.pinned) return false
      if (onlyMissing && item.status !== 'missing') return false
      return matchesQuery(item, query)
    })
  }, [clipboardItems, scopedItems, typeFilter, onlyPinned, onlyMissing, query])
  const pinned = visible.filter((item) => item.pinned)
  const regular = visible.filter((item) => !item.pinned)
  const orderedIds = visible.map((item) => item.id)
  const selectionItems = items.filter((item) => selection.includes(item.id))
  const allSelectedPinned =
    selectionItems.length > 0 && selectionItems.every((item) => item.pinned)

  visibleRef.current = visible
  selectionRef.current = selection

  const resolvedTheme =
    settings?.theme === 'light'
      ? 'light'
      : settings?.theme === 'dark'
        ? 'dark'
        : systemDark
          ? 'dark'
          : 'light'

  const showEntering = (): void => {
    setEntering(true)
    if (enteringTimer.current) window.clearTimeout(enteringTimer.current)
    enteringTimer.current = window.setTimeout(() => setEntering(false), 360)
  }

  /**
   * Shows the shelf with a smooth entrance. The content stays fully transparent
   * until the native window has been composited (two animation frames), so the
   * first visible frame is the start of the animation instead of a flash.
   */
  const beginEnter = (): void => {
    if (enteringTimer.current) window.clearTimeout(enteringTimer.current)
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    // Apply the entrance in the same React commit that makes the shell visible:
    // the animation's 0% keyframe is fully transparent, so the first painted
    // frame is the start of the fade instead of a flash of the finished card.
    setPre(false)
    showEntering()
  }

  const pushToast = (message: string, tone: ToastTone = 'info'): void => {
    useAppStore.getState().pushToast(message, tone)
  }

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme
    root.dataset.glass = String(Boolean(settings?.glass && host?.supportsAcrylic))
    root.dataset.reduceMotion = String(Boolean(settings?.reduceMotion))
    const colors = resolveThemeColors(resolvedTheme, settings ?? null)
    applyThemeVariables(root, {
      ...colors,
      glass: Boolean(settings?.glass && host?.supportsAcrylic)
    })
  }, [
    resolvedTheme,
    settings?.glass,
    settings?.reduceMotion,
    settings?.darkBackground,
    settings?.darkAccent,
    settings?.lightBackground,
    settings?.lightAccent,
    host?.supportsAcrylic
  ])

  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    // Safety net for the "content stays invisible" state: if the show command
    // never arrives (renderer subscribed late), reveal the shell anyway so the
    // UI can never end up permanently transparent.
    const timer = window.setTimeout(() => {
      const state = useAppStore.getState()
      if (!state.windowVisible && state.snapshot) state.setWindowVisible(true)
    }, 2000)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    showEntering()
    return () => {
      if (enteringTimer.current) window.clearTimeout(enteringTimer.current)
    }
  }, [])

  useEffect(() => {
    // Load the heavier settings bundle after first paint so the shelf itself
    // stays small and opens instantly; opening settings later is then cached.
    const timer = window.setTimeout(() => {
      void import('./components/SettingsPanel')
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    const api = window.flowtray
    if (!api) return

    const handleCommand = (command: UiCommand): void => {
      const state = useAppStore.getState()
      switch (command.type) {
        case 'open-settings':
          state.openSettings(command.section ?? 'general')
          break
        case 'open-onboarding':
          state.openOnboarding()
          break
        case 'open-clear-confirm':
          state.setConfirm('clear-shelf')
          break
        case 'focus-search':
          window.requestAnimationFrame(() => {
            searchRef.current?.focus()
            searchRef.current?.select()
          })
          break
        case 'toast':
          state.pushToast(command.message, command.tone)
          break
        case 'drag-out-start':
          break
        case 'drag-out-end':
          state.setDragOut(null)
          internalDragRef.current = false
          break
        case 'window-shown':
          state.setWindowVisible(true)
          state.closeMenu()
          beginEnter()
          break
        case 'window-will-hide':
          state.setWindowVisible(false)
          state.closeMenu()
          state.setDropActive(false)
          state.setDropBusyLabel(null)
          state.setDragOut(null)
          internalDragRef.current = false
          setPre(false)
          // Tell the backend when the leave animation is done so the native
          // window is hidden exactly at the end instead of mid-transition.
          if (hideTimer.current) window.clearTimeout(hideTimer.current)
          hideTimer.current = window.setTimeout(() => {
            hideTimer.current = null
            window.flowtray?.window.hideReady()
          }, 180)
          break
        case 'blur':
          state.closeMenu()
          break
        case 'items-expired':
          break
        default:
          break
      }
    }

    api.app
      .getSnapshot()
      .then((value) => {
        if (cancelled) return
        useAppStore.getState().setSnapshot(value)
        if (!value.settings.onboardingDone && !initialHandled.current) {
          initialHandled.current = true
          useAppStore.getState().openOnboarding()
        }
      })
      .catch(() => {
        if (!cancelled) pushToast('无法读取暂存台状态，请重启应用。', 'error')
      })

    const offSnapshot = api.app.onSnapshot((value) => {
      if (!cancelled) useAppStore.getState().setSnapshot(value)
    })
    const offCommand = api.app.onCommand(handleCommand)
    return () => {
      cancelled = true
      offSnapshot()
      offCommand()
    }
  }, [])

  useEffect(() => {
    const onDragStart = (): void => {
      internalDragRef.current = true
      window.setTimeout(() => {
        internalDragRef.current = false
      }, 5000)
    }
    const onMouseUp = (): void => {
      window.setTimeout(() => {
        internalDragRef.current = false
      }, 400)
    }
    document.addEventListener('dragstart', onDragStart, true)
    document.addEventListener('mouseup', onMouseUp, true)
    return () => {
      document.removeEventListener('dragstart', onDragStart, true)
      document.removeEventListener('mouseup', onMouseUp, true)
    }
  }, [])

  useEffect(() => {
    const api = window.flowtray
    if (!api) return
    let nativeSeen = false
    let processing = false
    let lastEffect: DragEffect | null = null
    let sourcePromise: Promise<string | null> = Promise.resolve(null)

    const resetDrag = (): void => {
      lastEffect = null
      useAppStore.getState().setDropActive(false)
      api.window.setInteractionLock(false)
    }

    const report = (result: MutationResult, effect: DragEffect): void => {
      if (result.added > 0) {
        const prefix = effect === 'cut' ? '已剪切到流转台' : '已存入流转台'
        useAppStore.getState().pushToast(
          `${prefix} ${result.added} 项${result.duplicates > 0 ? `，${result.duplicates} 项已存在` : ''}。`,
          'success'
        )
      } else if (result.duplicates > 0) {
        useAppStore.getState().pushToast('已在暂存台中，已为你置顶。', 'info')
      }
      if (result.errors.length > 0) {
        const firstError = result.errors[0]
        const suffix = result.errors.length > 1 ? `（共 ${result.errors.length} 个问题）` : ''
        useAppStore.getState().pushToast(`${firstError.message}${suffix}`, 'error')
      } else if (!result.ok && result.added === 0 && result.duplicates === 0) {
        useAppStore.getState().pushToast('没有可暂存的内容。', 'info')
      }
    }

    const effectFor = (flags: { ctrl: boolean; shift: boolean; alt: boolean }): DragEffect => {
      const currentSettings = useAppStore.getState().snapshot?.settings
      if (!currentSettings) return 'copy'
      const pressed = Boolean(flags[currentSettings.dragModifier])
      return invertedEffect(currentSettings.dropEffect, pressed) as DragEffect
    }

    const startSource = (): void => {
      sourcePromise = api.app
        .foreground()
        .then((info) => info?.appName ?? null)
        .catch(() => null)
    }

    const ingest = async (payload: NativeDropPayload, forced?: DragEffect): Promise<void> => {
      if (processing) return
      const state = useAppStore.getState()
      const effect = forced ?? effectFor(payload)
      processing = true
      resetDrag()
      state.setDropBusyLabel(
        payload.paths.length > 0 ? `正在接收 ${payload.paths.length} 项…` : '正在写入暂存台…'
      )
      const finish = (): void => {
        processing = false
        window.setTimeout(() => useAppStore.getState().setDropBusyLabel(null), 420)
        api.window.setInteractionLock(false)
      }
      const sourceApp = await Promise.race([
        sourcePromise,
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 300))
      ])
      try {
        if (payload.paths.length > 0) {
          const result = await api.items.addPaths(payload.paths, {
            effect,
            sourceApp,
            source: 'drop'
          })
          report(result, effect)
          return
        }
        if (payload.urls.length > 0) {
          const result = await api.items.addUrls(payload.urls, sourceApp)
          report(result, 'copy')
          return
        }
        if (payload.text.trim()) {
          const result = await api.items.addText({
            text: payload.text,
            html: payload.html || null,
            sourceApp,
            source: 'drop'
          })
          report(result, 'copy')
          return
        }
        state.pushToast('暂不支持这种内容。可以拖入文件、文件夹、图片、文本或链接。', 'error')
      } catch (error) {
        state.pushToast('接收失败，请检查文件权限或磁盘空间。', 'error')
        console.error(error)
      } finally {
        finish()
      }
    }

    const offFileDrop = onFileDrop({
      onEnter: () => {
        nativeSeen = true
        if (processing) return
        const state = useAppStore.getState()
        state.setDropActive(true)
        api.window.setInteractionLock(true)
        startSource()
        const currentSettings = state.snapshot?.settings
        if (currentSettings) {
          lastEffect = currentSettings.dropEffect as DragEffect
          state.setDropEffect(currentSettings.dropEffect as DragEffect)
        }
      },
      onOver: (): void => undefined,
      onLeave: () => {
        if (processing) return
        resetDrag()
      },
      onDrop: (paths) => {
        nativeSeen = true
        void ingest(
          {
            paths,
            text: '',
            html: '',
            urls: [],
            ctrl: false,
            shift: false,
            alt: false,
            x: 0,
            y: 0
          },
          lastEffect ?? undefined
        )
      }
    })

    const offNative = onNativeDrop({
      onEnter: (payload) => {
        nativeSeen = true
        if (processing) return
        const state = useAppStore.getState()
        state.setDropActive(true)
        api.window.setInteractionLock(true)
        startSource()
        const effect = effectFor(payload)
        lastEffect = effect
        state.setDropEffect(effect)
      },
      onOver: (payload) => {
        const state = useAppStore.getState()
        const effect = effectFor(payload)
        if (lastEffect !== effect) {
          lastEffect = effect
          state.setDropEffect(effect)
        }
      },
      onLeave: () => {
        if (processing) return
        resetDrag()
      },
      onDrop: (payload) => {
        nativeSeen = true
        void ingest(payload, lastEffect ?? undefined)
      }
    })

    // Fallback for the rare case where the native OLE target is unavailable:
    // WebView2 then delivers plain HTML5 drag events, which still carry text.
    const domOver = (event: DragEvent): void => {
      if (nativeSeen) return
      event.preventDefault()
    }
    const domDrop = (event: DragEvent): void => {
      if (nativeSeen || processing) return
      event.preventDefault()
      const transfer = event.dataTransfer
      if (!transfer) return
      const text = transfer.getData('text/plain')
      const html = transfer.getData('text/html')
      const uriList = transfer.getData('text/uri-list')
      const urls = uriList
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^https?:\/\//i.test(line))
        .slice(0, 20)
      void ingest({
        paths: [],
        text,
        html,
        urls,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        x: 0,
        y: 0
      })
    }
    document.addEventListener('dragover', domOver)
    document.addEventListener('drop', domDrop)

    return () => {
      offFileDrop()
      offNative()
      document.removeEventListener('dragover', domOver)
      document.removeEventListener('drop', domDrop)
      api.window.setInteractionLock(false)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editable = Boolean(
        target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable)
      )
      const state = useAppStore.getState()
      const mod = event.ctrlKey || event.metaKey
      const key = event.key

      if (key === 'Escape') {
        if (state.confirm) {
          state.setConfirm(null)
          event.preventDefault()
          return
        }
        if (state.menu) {
          state.closeMenu()
          event.preventDefault()
          return
        }
        if (state.overlay === 'onboarding') {
          event.preventDefault()
          state.closeOverlay()
          void window.flowtray.settings.update({ onboardingDone: true })
          return
        }
        if (state.overlay !== 'none') {
          event.preventDefault()
          state.closeOverlay()
          return
        }
        if (state.selection.length > 0) {
          event.preventDefault()
          state.clearSelection()
          return
        }
        if (!editable) {
          event.preventDefault()
          void window.flowtray.app.hideWindow()
        }
        return
      }

      if (editable) return
      if (state.overlay !== 'none' || state.confirm || state.menu) return

      if (mod && key.toLowerCase() === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (mod && key === ',') {
        event.preventDefault()
        state.openSettings('general')
        return
      }
      if (mod && key.toLowerCase() === 'a') {
        event.preventDefault()
        state.setSelection(visibleRef.current.map((item) => item.id))
        return
      }
      if (mod && (key.toLowerCase() === 'c' || key.toLowerCase() === 'x')) {
        const ids = selectionRef.current
        if (ids.length === 0) return
        event.preventDefault()
        void window.flowtray.items.copy(ids, event.shiftKey ? 'path' : 'auto').then((result) => {
          if (result.ok) state.pushToast(result.message ?? '已复制。', 'success')
          else state.pushToast(result.message ?? '复制失败。', 'error')
        })
        return
      }
      if (key === 'Delete' || key === 'Backspace') {
        const ids = selectionRef.current
        if (ids.length === 0) return
        event.preventDefault()
        void window.flowtray.items.remove(ids).then((result) => {
          if (result.ok) {
            state.clearSelection()
            state.pushToast(`已删除 ${ids.length} 项，可在下方撤销。`, 'info')
          }
        })
        return
      }
      if (key === 'Enter') {
        const ids = selectionRef.current
        if (ids.length !== 1) return
        event.preventDefault()
        const item = visibleRef.current.find((entry) => entry.id === ids[0])
        if (!item) return
        if (item.status === 'missing') {
          void window.flowtray.items.relocate(item.id)
        } else if (item.type === 'text') {
          state.openInfo(item.id)
        } else {
          void window.flowtray.items.openItem(item.id).then((result) => {
            if (!result.ok) state.pushToast(result.message ?? '打开失败。', 'error')
          })
        }
        return
      }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        const list = visibleRef.current
        if (list.length === 0) return
        const currentId = selectionRef.current[0]
        let index = list.findIndex((item) => item.id === currentId)
        if (index < 0) index = -1
        const next = key === 'ArrowDown' ? Math.min(list.length - 1, index + 1) : Math.max(0, index - 1)
        const nextItem = list[next]
        if (nextItem) {
          state.selectOnly(nextItem.id)
          window.requestAnimationFrame(() => {
            const element = document.querySelector<HTMLElement>(`[data-item-id="${nextItem.id}"]`)
            element?.scrollIntoView({ block: 'nearest' })
            element?.focus({ preventScroll: true })
          })
        }
        return
      }
      if (key === '/' && !mod && !event.altKey) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (key.length === 1 && !mod && !event.altKey && !event.shiftKey) {
        state.setQuery(key)
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const relocate = async (id: string): Promise<void> => {
    const result = await window.flowtray.items.relocate(id)
    if (result.ok) pushToast('已重新定位。', 'success')
    else if (result.errors[0]?.code !== 'invalid') {
      pushToast(result.errors[0]?.message ?? '重新定位失败。', 'error')
    }
  }

  if (!snapshot || !settings) {
    return (
      <div className="app-shell" data-side="right">
        <div className="shelf">
          <div className="boot">
            <BrandMark size={48} />
            <div>正在打开流转台</div>
            <div className="boot-dots">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
        <EdgePeek />
      </div>
    )
  }

  return (
    <div
      className={cx(
        'app-shell',
        !windowVisible && 'is-leaving',
        pre && 'is-pre',
        entering && 'is-entering'
      )}
      data-side={settings.shelfSide}
      data-testid="app-shell"
    >
      <div className="shelf" data-testid="shelf">
        <Header />
        <SearchFilter searchRef={searchRef} counts={counts} />
        <main
          className="content"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              useAppStore.getState().clearSelection()
            }
          }}
        >
          {visible.length === 0 ? (
            <EmptyState
              hasItems={items.length > 0}
              clipboardCount={settings?.clipboardSeparate ? counts.clipboard : 0}
            />
          ) : (
            <ItemList
              clipboardCount={
                settings?.clipboardSeparate && typeFilter === 'all' ? counts.clipboard : 0
              }
              folders={activeFolder ? [] : folderGroups}
              activeFolder={activeFolder ? activeFolder.label : null}
              pinned={pinned}
              regular={regular}
              orderedIds={orderedIds}
              mode={settings.viewMode}
              query={query}
              onRelocate={(id) => void relocate(id)}
            />
          )}
        </main>
        <Footer />
        {selectionItems.length > 0 ? (
          <SelectionBar
            selection={selectionItems}
            allPinned={allSelectedPinned}
          />
        ) : null}
        {dragOut ? (
          <div className="drag-hint" role="status">
            <Move size={13} strokeWidth={1.9} />
            <span>把文件拖到目标窗口（微信 / 资源管理器 / 桌面）松手即可</span>
          </div>
        ) : null}
        <ToastHost />
        <ResizeHandles />
        <DropOverlay />
        {overlay === 'settings' ? (
          <Suspense fallback={null}>
            <SettingsPanel />
          </Suspense>
        ) : null}
        {overlay === 'onboarding' ? <Onboarding /> : null}
        {overlay === 'info' ? <InfoSheet /> : null}
        {menu ? <ContextMenu /> : null}
        {confirm ? <ConfirmDialog /> : null}
      </div>
      <EdgePeek />
    </div>
  )
}
