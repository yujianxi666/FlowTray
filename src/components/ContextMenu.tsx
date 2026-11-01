import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Copy,
  Eye,
  FolderOpen,
  FolderSearch,
  History,
  Info,
  Link2,
  Pin,
  PinOff,
  Trash2
} from 'lucide-react'
import { useAppStore } from '../store'
import { isFileLike } from '../lib/utils'

interface Action {
  key: string
  label: string
  icon: typeof Copy
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export function ContextMenu() {
  const menu = useAppStore((state) => state.menu)
  const closeMenu = useAppStore((state) => state.closeMenu)
  const snapshot = useAppStore((state) => state.snapshot)
  const openInfo = useAppStore((state) => state.openInfo)
  const pushToast = useAppStore((state) => state.pushToast)
  const card = menu ? snapshot?.items.find((item) => item.id === menu.itemId) : null
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const margin = 8
    let left = menu.x
    let top = menu.y
    if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - rect.width - margin
    if (top + rect.height > window.innerHeight - margin) top = menu.y - rect.height
    if (left < margin) left = margin
    if (top < margin) top = margin
    setPosition({ left, top })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    ref.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        const buttons = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
        )
        if (buttons.length === 0) return
        const active = document.activeElement as HTMLButtonElement | null
        const current = active ? buttons.indexOf(active) : -1
        let next = current
        if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = buttons.length - 1
        else if (event.key === 'ArrowDown') next = (current + 1 + buttons.length) % buttons.length
        else next = (current - 1 + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [menu, closeMenu])

  if (!menu || !card) return null

  const run = (action: () => void | Promise<void>) => () => {
    closeMenu()
    void Promise.resolve(action())
  }

  const copy = async (kind: 'auto' | 'path'): Promise<void> => {
    const result = await window.flowtray.items.copy([card.id], kind)
    if (result.ok) pushToast(result.message ?? '已复制。', 'success')
    else pushToast(result.message ?? '复制失败。', 'error')
  }

  const open = async (): Promise<void> => {
    if (card.status === 'missing') {
      const result = await window.flowtray.items.relocate(card.id)
      if (!result.ok && result.errors[0]?.code !== 'invalid') {
        pushToast(result.errors[0]?.message ?? '重新定位失败。', 'error')
      }
      return
    }
    if (card.type === 'text') {
      openInfo(card.id)
      return
    }
    const result = await window.flowtray.items.openItem(card.id)
    if (!result.ok) pushToast(result.message ?? '打开失败。', 'error')
  }

  const reveal = async (): Promise<void> => {
    const result = await window.flowtray.items.reveal(card.id)
    if (!result.ok) pushToast(result.message ?? '定位失败。', 'error')
  }

  const pin = async (): Promise<void> => {
    const result = await window.flowtray.items.update(card.id, { pinned: !card.pinned })
    if (result.ok) {
      pushToast(card.pinned ? '已取消固定。' : '已固定，不会被自动清理。', 'success')
    }
  }

  const refresh = async (): Promise<void> => {
    const result = await window.flowtray.items.relocate(card.id)
    if (result.ok) pushToast('已重新定位。', 'success')
    else if (result.errors[0]?.code !== 'invalid') {
      pushToast(result.errors[0]?.message ?? '重新定位失败。', 'error')
    }
  }

  const restore = async (): Promise<void> => {
    const result = await window.flowtray.items.restoreOriginal(card.id)
    if (result.ok) pushToast(result.message ?? '已放回原处。', 'success')
    else pushToast(result.errors[0]?.message ?? '放回失败。', 'error')
  }

  const remove = async (): Promise<void> => {
    const result = await window.flowtray.items.remove([card.id])
    if (result.ok) pushToast('已删除，可在下方撤销。', 'info')
  }

  const entries: Array<Action | 'separator'> = [
    {
      key: 'open',
      label: card.status === 'missing' ? '重新定位…' : card.type === 'text' ? '查看内容' : '打开',
      icon: card.status === 'missing' ? FolderSearch : card.type === 'text' ? Eye : FolderOpen,
      shortcut: 'Enter',
      onSelect: () => void open()
    },
    ...(isFileLike(card) && card.status !== 'missing'
      ? [
          {
            key: 'reveal',
            label: '在文件夹中显示',
            icon: FolderOpen,
            onSelect: () => void reveal()
          } as Action
        ]
      : []),
    'separator',
    {
      key: 'copy',
      label: card.type === 'text' ? '复制文本' : card.type === 'url' ? '复制链接' : card.type === 'image' ? '复制图片' : '复制文件',
      icon: Copy,
      shortcut: 'Ctrl+C',
      disabled: card.status === 'missing',
      onSelect: () => void copy('auto')
    },
    ...(isFileLike(card)
      ? [
          {
            key: 'copy-path',
            label: '复制路径',
            icon: Link2,
            shortcut: 'Ctrl+Shift+C',
            disabled: card.status === 'missing',
            onSelect: () => void copy('path')
          } as Action
        ]
      : []),
    'separator',
    {
      key: 'pin',
      label: card.pinned ? '取消固定' : '固定到暂存台',
      icon: card.pinned ? PinOff : Pin,
      onSelect: () => void pin()
    },
    ...(card.movedIn
      ? [
          {
            key: 'restore',
            label: '放回原位置',
            icon: History,
            onSelect: () => void restore()
          } as Action
        ]
      : []),
    {
      key: 'info',
      label: '查看信息',
      icon: Info,
      onSelect: () => openInfo(card.id)
    },
    'separator',
    {
      key: 'delete',
      label: '删除',
      icon: Trash2,
      shortcut: 'Del',
      danger: true,
      onSelect: () => void remove()
    }
  ]

  return (
    <>
      <div
        className="menu-scrim"
        onMouseDown={closeMenu}
        onContextMenu={(event) => {
          event.preventDefault()
          closeMenu()
        }}
      />
      <div
        className="popup-menu"
        role="menu"
        aria-label={`${card.name} 的操作`}
        ref={ref}
        tabIndex={-1}
        style={{ left: position.left, top: position.top }}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        data-testid="context-menu"
      >
        <div className="popup-menu-head">
          <span className={`popup-head-icon type-${card.type}`}>
            {card.type === 'url' ? <Link2 size={12} /> : card.type === 'text' ? <Eye size={12} /> : <FolderOpen size={12} />}
          </span>
          <span className="popup-head-name" title={card.name}>
            {card.name}
          </span>
          {card.pinned ? <Pin size={10} className="popup-head-pin" /> : null}
        </div>
        {entries.map((entry, index) =>
          entry === 'separator' ? (
            <div key={`sep-${index}`} className="popup-sep" role="separator" />
          ) : (
            <button
              key={entry.key}
              type="button"
              role="menuitem"
              className={`popup-item ${entry.danger ? 'is-danger' : ''}`}
              disabled={entry.disabled}
              onClick={run(entry.onSelect)}
            >
              <entry.icon size={13} strokeWidth={1.8} />
              <span className="popup-item-label">{entry.label}</span>
              {entry.shortcut ? <span className="popup-shortcut">{entry.shortcut}</span> : null}
            </button>
          )
        )}
      </div>
    </>
  )
}
