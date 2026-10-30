import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { MutationResult, ShelfItemView, ToastTone, UiCommand } from '@shared/types'
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
  const confirm = useAppStore((state) => state.confirm)
  const openOnboarding = useAppStore((state) => state.openOnboarding)
  const openSettings = useAppStore((state) => state.openSettings)
  const searchRef = useRef<HTMLInputElement>(null)
  const internalDragRef = useRef(false)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  const [entering, setEntering] = useState(true)
  const [, setClock] = useState(0)
  const initialHandled = useRef(false)
  const enteringTimer = useRef<number | null>(null)
  const visibleRef = useRef<ShelfItemView[]>([])
  const selectionRef = useRef<string[]>([])

  const items = snapshot?.items ?? []
  const settings = snapshot?.settings
  const host = snapshot?.host

  const counts: Counts = useMemo(
    () => ({
      all: items.length,
      file: items.filter((item) => item.type === 'file' || item.type === 'folder').length,
      image: items.filter((item) => item.type === 'image').length,
      text: items.filter((item) => item.type === 'text').length,
      url: items.filter((item) => item.type === 'url').length,
      pinned: items.filter((item) => item.pinned).length,
      missing: items.filter((item) => item.status === 'missing').length
    }),
    [items]
  )

  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (!itemTypeMatches(item, typeFilter)) return false
        if (onlyPinned && !item.pinned) return false
        if (onlyMissing && item.status !== 'missing') return false
        return matchesQuery(item, query)
      }),
    [items, typeFilter, onlyPinned, onlyMissing, query]
  )
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
  }, [resolvedTheme, settings?.glass, settings?.reduceMotion, host?.supportsAcrylic])

  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 30_000)
    return () => window.clearInterval(timer)
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
          showEntering()
          break
        case 'window-will-hide':
          state.setWindowVisible(false)
          state.closeMenu()
          state.setDropActive(false)
          state.setDropBusyLabel(null)
          state.setDragOut(null)
          internalDragRef.current = false
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
    const dragDepth = { current: 0 }
    const processing = { current: false }
    const sourcePromise = { current: Promise.resolve<string | null>(null) }
    let lastEffect: string | null = null

    const resetDrag = (): void => {
      dragDepth.current = 0
      lastEffect = null
      useAppStore.getState().setDropActive(false)
      api.window.setInteractionLock(false)
    }

    const report = (result: MutationResult, effect: 'copy' | 'cut'): void => {
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
        const first = result.errors[0]
        const suffix = result.errors.length > 1 ? `（共 ${result.errors.length} 个问题）` : ''
        useAppStore.getState().pushToast(`${first.message}${suffix}`, 'error')
      } else if (!result.ok && result.added === 0 && result.duplicates === 0) {
        useAppStore.getState().pushToast('没有可暂存的内容。', 'info')
      }
    }

    const onDragEnter = (event: DragEvent): void => {
      if (internalDragRef.current || processing.current) return
      const types = Array.from(event.dataTransfer?.types ?? [])
      if (!types.includes('Files') && !types.includes('text/plain') && !types.includes('text/uri-list')) {
        return
      }
      event.preventDefault()
      dragDepth.current += 1
      if (dragDepth.current === 1) {
        const state = useAppStore.getState()
        const currentSettings = state.snapshot?.settings
        state.setDropActive(true)
        api.window.setInteractionLock(true)
        sourcePromise.current = api.app
          .foreground()
          .then((info) => info?.appName ?? null)
          .catch(() => null)
        const effect = invertedEffect(
          currentSettings?.dropEffect ?? 'copy',
          currentSettings
            ? modifierPressed(event, currentSettings.dragModifier)
            : false
        )
        state.setDropEffect(effect)
        lastEffect = effect
      }
    }

    const onDragOver = (event: DragEvent): void => {
      if (internalDragRef.current || processing.current) return
      if (dragDepth.current === 0) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      const state = useAppStore.getState()
      const currentSettings = state.snapshot?.settings
      if (!currentSettings) return
      const effect = invertedEffect(
        currentSettings.dropEffect,
        modifierPressed(event, currentSettings.dragModifier)
      )
      if (lastEffect !== effect) {
        lastEffect = effect
        state.setDropEffect(effect)
      }
    }

    const onDragLeave = (event: DragEvent): void => {
      if (internalDragRef.current) return
      if (dragDepth.current === 0) return
      event.preventDefault()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) {
        resetDrag()
      }
    }

    const onDrop = (event: DragEvent): void => {
      if (internalDragRef.current) return
      event.preventDefault()
      event.stopPropagation()
      const dataTransfer = event.dataTransfer
      if (!dataTransfer) {
        resetDrag()
        return
      }
      const state = useAppStore.getState()
      const currentSettings = state.snapshot?.settings
      const effect = invertedEffect(
        currentSettings?.dropEffect ?? 'copy',
        currentSettings
          ? modifierPressed(event, currentSettings.dragModifier)
          : false
      )
      const files = Array.from(dataTransfer.files ?? [])
      const paths: string[] = []
      for (const file of files) {
        try {
          const path = api.getPathForFile(file)
          if (path) paths.push(path)
        } catch {
          // ignore files without a local path
        }
      }
      const text = dataTransfer.getData('text/plain')
      const html = dataTransfer.getData('text/html')
      const uriList = dataTransfer.getData('text/uri-list')
      const urls = uriList
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^https?:\/\//i.test(line))
        .slice(0, 20)

      if (paths.length === 0 && files.length === 0 && !text.trim() && urls.length === 0) {
        resetDrag()
        state.pushToast('暂不支持这种内容。可以拖入文件、文件夹、图片、文本或链接。', 'error')
        return
      }

      processing.current = true
      resetDrag()
      state.setDropBusyLabel(
        paths.length > 0
          ? `正在接收 ${paths.length} 项…`
          : '正在写入暂存台…'
      )

      const finish = (): void => {
        processing.current = false
        window.setTimeout(() => {
          useAppStore.getState().setDropBusyLabel(null)
        }, 420)
        api.window.setInteractionLock(false)
      }

      const run = async (): Promise<void> => {
        const sourceApp = await Promise.race([
          sourcePromise.current,
          new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 300))
        ])
        try {
          if (paths.length > 0) {
            const result = await api.items.addPaths(paths, {
              effect,
              sourceApp,
              source: 'drop'
            })
            report(result, effect)
            return
          }

          if (files.length > 0) {
            const images = files.filter((file) => file.type.startsWith('image/'))
            if (images.length > 0) {
              for (const file of images.slice(0, 20)) {
                const buffer = await file.arrayBuffer()
                const result = await api.items.addImageBuffer({
                  data: buffer,
                  mime: file.type,
                  name: file.name || undefined,
                  sourceApp
                })
                report(result, 'copy')
              }
              return
            }
            state.pushToast('无法读取这些文件，请从资源管理器拖入。', 'error')
            return
          }

          if (urls.length > 0) {
            const result = await api.items.addUrls(urls, sourceApp)
            report(result, 'copy')
            return
          }

          if (text.trim()) {
            const result = await api.items.addText({
              text,
              html: html || null,
              sourceApp,
              source: 'drop'
            })
            report(result, 'copy')
          }
        } catch (error) {
          state.pushToast('接收失败，请检查文件权限或磁盘空间。', 'error')
          console.error(error)
        } finally {
          finish()
        }
      }

      void run()
    }

    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
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
        entering && 'is-entering'
      )}
      data-side={settings.shelfSide}
      data-testid="app-shell"
    >
      <div className="shelf" data-testid="shelf">
        <Header />        {host && !host.hotkeys.toggle.ok ? (
          <div className="warning-banner">
            <AlertTriangle size={12} />
            <span className="warning-text">
              全局呼出快捷键未生效：{host.hotkeys.toggle.error ?? '可能被其他应用占用。'}
            </span>
            <button type="button" onClick={() => openSettings('shortcuts')}>
              去设置
            </button>
          </div>
        ) : null}
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
            <EmptyState hasItems={items.length > 0} />
          ) : (
            <ItemList
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
