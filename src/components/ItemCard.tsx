import {
  useEffect,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent
} from 'react'
import {
  Check,
  Clock3,
  Copy,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Globe2,
  Image as ImageIcon,
  Infinity as InfinityIcon,
  MoreHorizontal,
  Pin,
  PinOff,
  Presentation,
  TriangleAlert
} from 'lucide-react'
import type { ShelfItemView } from '@shared/types'
import { formatCountdown } from '@shared/format'
import { useAppStore } from '../store'
import {
  buildDragGhost,
  buildDragIcon,
  cx,
  fileTypeClass,
  invertedEffect,
  isFileLike,
  metaLine,
  modifierPressed,
  sourceLabel,
  ttlTone,
  typeLabel
} from '../lib/utils'
import { Highlight } from './ui'

interface ItemCardProps {
  item: ShelfItemView
  mode: 'list' | 'grid'
  query: string
  selected: boolean
  orderedIds: string[]
  showSource: boolean
  onRelocate: (id: string) => void
}

export function ItemCard({
  item,
  mode,
  query,
  selected,
  orderedIds,
  showSource,
  onRelocate
}: ItemCardProps) {
  const snapshot = useAppStore((state) => state.snapshot)
  const dragOut = useAppStore((state) => state.dragOut)
  const selectOnly = useAppStore((state) => state.selectOnly)
  const toggleSelect = useAppStore((state) => state.toggleSelect)
  const selectRange = useAppStore((state) => state.selectRange)
  const openMenu = useAppStore((state) => state.openMenu)
  const openInfo = useAppStore((state) => state.openInfo)
  const pushToast = useAppStore((state) => state.pushToast)
  const [thumbFailed, setThumbFailed] = useState(false)

  useEffect(() => {
    setThumbFailed(false)
  }, [item.thumbUrl])

  const settings = snapshot?.settings
  const missing = item.status === 'missing'
  const dragging = Boolean(dragOut?.ids.includes(item.id))
  const source = showSource ? sourceLabel(item) : null
  const tone = ttlTone(item)
  const meta = metaLine(item)

  const handleSelect = (event: MouseEvent): void => {
    if (event.button !== 0) return
    if (event.ctrlKey || event.metaKey) {
      toggleSelect(item.id)
      return
    }
    if (event.shiftKey) {
      selectRange(item.id, orderedIds)
      return
    }
    if (selected && useAppStore.getState().selection.length > 1) {
      selectOnly(item.id)
      return
    }
    if (!selected) selectOnly(item.id)
  }

  const handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const state = useAppStore.getState()
    if (!state.selection.includes(item.id) && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      selectOnly(item.id)
    }
    if (isFileLike(item) && !missing) beginFileDrag(event)
  }

  /**
   * Native drag-out for files and folders.
   *
   * HTML5 `dragstart` cannot be used for this: while the browser owns the drag
   * gesture the OLE drag loop never sees the button release, so the native
   * `DoDragDrop` never returns and the shelf stops reacting to the mouse. The
   * gesture is detected here instead and the backend takes over the mouse.
   */
  const beginFileDrag = (event: PointerEvent): void => {
    if (!settings || missing) return
    const state = useAppStore.getState()
    const allItems = state.snapshot?.items ?? []
    const byId = new Map(allItems.map((entry) => [entry.id, entry]))
    const selectedIds =
      state.selection.includes(item.id) && state.selection.length > 1
        ? state.selection
        : [item.id]
    const fileIds = selectedIds.filter((id) => {
      const entry = byId.get(id)
      return entry && isFileLike(entry) && entry.status !== 'missing'
    })
    if (fileIds.length === 0) return

    const startX = event.clientX
    const startY = event.clientY
    let launched = false
    const stop = (): void => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', stop, true)
      window.removeEventListener('pointercancel', stop, true)
    }
    const onMove = (move: globalThis.PointerEvent): void => {
      if (launched) return
      if ((move.buttons & 1) === 0) {
        stop()
        return
      }
      if (Math.abs(move.clientX - startX) + Math.abs(move.clientY - startY) < 6) return
      launched = true
      stop()
      const effect = 'copy' as const
      // Dragging out always hands over a safe copy; the inversion key only flips
      // whether the card is removed afterwards (handled in the backend).
      state.setDragOut({ ids: fileIds, effect })
      window.flowtray.items.startDrag({
        ids: fileIds,
        effect,
        iconDataUrl: buildDragIcon(fileIds.length, effect)
      })
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', stop, true)
    window.addEventListener('pointercancel', stop, true)
  }

  const open = async (): Promise<void> => {
    if (missing) {
      onRelocate(item.id)
      return
    }
    if (item.type === 'text') {
      openInfo(item.id)
      return
    }
    const result = await window.flowtray.items.openItem(item.id)
    if (!result.ok) pushToast(result.message ?? '无法打开。', 'error')
  }

  const copy = async (): Promise<void> => {
    const result = await window.flowtray.items.copy([item.id], 'auto')
    if (result.ok) pushToast(result.message ?? '已复制。', 'success')
    else pushToast(result.message ?? '复制失败。', 'error')
  }

  const togglePin = async (): Promise<void> => {
    const result = await window.flowtray.items.update(item.id, { pinned: !item.pinned })
    if (result.ok) {
      pushToast(item.pinned ? '已取消固定，恢复到期计时。' : '已固定，不会被自动清理。', 'success')
    }
  }

  const more = (event: MouseEvent): void => {
    event.stopPropagation()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    openMenu({
      x: Math.max(8, Math.min(window.innerWidth - 228, rect.right - 218)),
      y: Math.min(window.innerHeight - 20, rect.bottom + 4),
      itemId: item.id
    })
  }

  const contextMenu = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!useAppStore.getState().selection.includes(item.id)) {
      selectOnly(item.id)
    }
    openMenu({
      x: Math.min(event.clientX, window.innerWidth - 232),
      y: Math.min(event.clientY, window.innerHeight - 40),
      itemId: item.id
    })
  }

  const selectFromCheck = (event: MouseEvent): void => {
    event.stopPropagation()
    if (event.shiftKey) selectRange(item.id, orderedIds)
    else toggleSelect(item.id)
  }

  const startDrag = (event: DragEvent): void => {
    if (!settings || missing) {
      event.preventDefault()
      return
    }
    // Files and folders are handed to the native OLE drag in `beginFileDrag`;
    // only text and links use the DOM drag so they can be dropped into any
    // editor as rich text.
    if (isFileLike(item)) {
      event.preventDefault()
      return
    }
    const state = useAppStore.getState()
    const selectedIds = state.selection.includes(item.id) && state.selection.length > 1
      ? state.selection
      : [item.id]
    const allItems = state.snapshot?.items ?? []
    const byId = new Map(allItems.map((entry) => [entry.id, entry]))

    const textIds = selectedIds.filter((id) => {
      const entry = byId.get(id)
      return entry && (entry.type === 'text' || entry.type === 'url')
    })
    const text = textIds
      .map((id) => byId.get(id)?.textContent ?? '')
      .filter(Boolean)
      .join('\n\n')
    if (!text) {
      event.preventDefault()
      return
    }
    event.dataTransfer.setData('text/plain', text)
    if (item.type === 'url' && item.url) {
      event.dataTransfer.setData('text/uri-list', item.url)
    }
    event.dataTransfer.effectAllowed = 'copyMove'
    const ghost = buildDragGhost(textIds.length, 'copy')
    event.dataTransfer.setDragImage(ghost, 24, 26)
    state.setDragOut({ ids: textIds, effect: 'copy' })
  }

  const endDrag = (): void => {
    const state = useAppStore.getState()
    if (state.dragOut && !isFileLike(item)) {
      state.setDragOut(null)
    }
  }

  const keyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void open()
    } else if (event.key === ' ') {
      event.preventDefault()
      if (event.shiftKey) selectRange(item.id, orderedIds)
      else toggleSelect(item.id)
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      openMenu({ x: rect.left + 24, y: rect.top + 28, itemId: item.id })
    }
  }

  const ttl = ttlTitle(item)
  const thumb = (
    <Thumb
      item={item}
      failed={thumbFailed}
      onFailed={() => setThumbFailed(true)}
      mode={mode}
    />
  )

  const selectButton = (
    <button
      type="button"
      className="select-check"
      aria-label={selected ? '取消选择' : '选择此项'}
      aria-pressed={selected}
      onClick={selectFromCheck}
    >
      <Check size={9} strokeWidth={2.6} />
    </button>
  )

  if (mode === 'grid') {
    return (
      <article
        className={cx(
          'grid-card',
          selected && 'is-selected',
          missing && 'is-missing',
          dragging && 'is-drag-source'
        )}
        style={{ animationDelay: `${Math.min(120, orderedIds.indexOf(item.id) * 18)}ms` }}
        draggable={!missing && !isFileLike(item)}
        onDragStart={isFileLike(item) ? undefined : startDrag}
        onDragEnd={endDrag}
        onClick={handleSelect}
        onDoubleClick={() => void open()}
        onPointerDown={handlePointerDown}
        onContextMenu={contextMenu}
        onKeyDown={keyDown}
        tabIndex={0}
        aria-label={`${typeLabel(item)}：${item.name}`}
        data-testid="item-card"
        data-item-id={item.id}
      >
        {selectButton}
        {item.pinned ? (
          <span className="grid-pin" title="已固定，不会自动清理">
            <Pin size={11} fill="currentColor" strokeWidth={1.6} />
          </span>
        ) : null}
        <div className="grid-thumb">{thumb}</div>
        <div className="grid-body">
          <div className="grid-name" title={item.name}>
            <Highlight text={item.name} query={query} />
          </div>
          <div className="grid-meta">
            <span>{meta[0]}</span>
            <span>·</span>
            <span>{meta[1]}</span>
            {source ? (
              <>
                <span>·</span>
                <span>{source}</span>
              </>
            ) : null}
          </div>
          <div className="grid-foot">
            <span className={cx('ttl', `is-${tone}`)} title={ttl}>
              {missing ? (
                <>
                  <TriangleAlert size={9} /> 失效
                </>
              ) : item.pinned ? (
                <>
                  <Pin size={9} /> 固定
                </>
              ) : item.expiresAt == null ? (
                <>
                  <InfinityIcon size={10} /> 永久
                </>
              ) : (
                <>
                  <Clock3 size={9} /> {compactTtl(item)}
                </>
              )}
            </span>
            <div className="grid-actions" onClick={(event) => event.stopPropagation()}>
              <button type="button" className="icon-button" title="复制" onClick={() => void copy()}>
                <Copy size={12} strokeWidth={1.9} />
              </button>
              <button
                type="button"
                className="icon-button"
                title={item.pinned ? '取消固定' : '固定'}
                onClick={() => void togglePin()}
              >
                {item.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              </button>
              <button
                type="button"
                className="icon-button"
                title="更多操作"
                onClick={more}
              >
                <MoreHorizontal size={13} />
              </button>
            </div>
          </div>
        </div>
      </article>
    )
  }

  return (
    <article
      className={cx(
        'item-card',
        selected && 'is-selected',
        missing && 'is-missing',
        dragging && 'is-drag-source'
      )}
      draggable={!missing && !isFileLike(item)}
      onDragStart={isFileLike(item) ? undefined : startDrag}
      onDragEnd={endDrag}
      onClick={handleSelect}
      onDoubleClick={() => void open()}
      onPointerDown={handlePointerDown}
      onContextMenu={contextMenu}
      onKeyDown={keyDown}
      tabIndex={0}
      aria-label={`${typeLabel(item)}：${item.name}`}
      data-testid="item-card"
      data-item-id={item.id}
    >
      {selectButton}
      {thumb}
      <div className="item-body">
        <div className="item-name" title={item.name}>
          <span className="name-text">
            <Highlight text={item.name} query={query} />
          </span>
          {item.pinned ? (
            <Pin
              className="pin-mini"
              size={9}
              strokeWidth={1.8}
              fill="currentColor"
              aria-label="已固定"
            />
          ) : null}
        </div>
        <div className="item-meta">
          {missing ? (
            <>
              <span className="missing-text">文件已移动或删除</span>
              <button
                type="button"
                className="recover-btn"
                onClick={(event) => {
                  event.stopPropagation()
                  onRelocate(item.id)
                }}
              >
                重新定位
              </button>
            </>
          ) : (
            <>
              <span className="meta-strong">{meta[0]}</span>
              <span className="meta-dot" />
              <span>{meta[1]}</span>
              {source ? (
                <span className="meta-source" title={`来源：${source}`}>
                  {source}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div className="item-side" title={ttl}>
        {missing ? (
          <span className="ttl is-missing">
            <TriangleAlert size={9} /> 失效
          </span>
        ) : item.pinned ? (
          <span className="ttl is-pinned">
            <Pin size={10} fill="currentColor" />
          </span>
        ) : item.expiresAt == null ? (
          <span className="ttl is-never">
            <InfinityIcon size={10} />
          </span>
        ) : (
          <span className={cx('ttl', `is-${tone}`)}>
            <Clock3 size={9} />
            {compactTtl(item)}
          </span>
        )}
      </div>
      <div className="card-actions" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-button" title="复制" onClick={() => void copy()}>
          <Copy size={13} strokeWidth={1.9} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={item.pinned ? '取消固定' : '固定'}
          onClick={() => void togglePin()}
        >
          {item.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
        <button type="button" className="icon-button" title="更多操作" onClick={more}>
          <MoreHorizontal size={14} />
        </button>
      </div>
    </article>
  )
}

function compactTtl(item: ShelfItemView): string {
  if (!item.expiresAt) return '∞'
  const remaining = item.expiresAt - Date.now()
  if (remaining <= 0) return '0m'
  if (remaining < 60 * 60_000) return `${Math.max(1, Math.ceil(remaining / 60_000))}m`
  if (remaining < 24 * 60 * 60_000) return `${Math.ceil(remaining / 3_600_000)}h`
  return `${Math.ceil(remaining / 86_400_000)}d`
}

function ttlTitle(item: ShelfItemView): string {
  if (item.pinned) return '已固定：不会被自动清理'
  if (item.status === 'missing') return '文件已移动或删除，可右键重新定位'
  if (item.expiresAt == null) return '永久保留'
  return `到期时间：${new Date(item.expiresAt).toLocaleString('zh-CN', { hour12: false })}\n${formatCountdown(item.expiresAt - Date.now())}`
}

function Thumb({
  item,
  failed,
  onFailed,
  mode
}: {
  item: ShelfItemView
  failed: boolean
  onFailed: () => void
  mode: 'list' | 'grid'
}) {
  if (item.thumbUrl && !failed) {
    return (
      <img
        src={item.thumbUrl}
        alt=""
        draggable={false}
        loading="lazy"
        onError={onFailed}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover'
        }}
      />
    )
  }
  const typeClass = fileTypeClass(item)
  return (
    <div className={`thumb-fallback ${typeClass}`}>
      {item.type === 'text' ? (
        <span className="paper-lines">
          <i />
          <i />
          <i />
        </span>
      ) : item.type === 'url' ? (
        <Globe2 size={mode === 'grid' ? 22 : 16} strokeWidth={1.6} />
      ) : item.type === 'image' ? (
        <ImageIcon size={mode === 'grid' ? 22 : 16} strokeWidth={1.6} />
      ) : item.type === 'folder' ? (
        <Folder size={mode === 'grid' ? 22 : 16} strokeWidth={1.6} />
      ) : (
        <>
          <TypeFileIcon item={item} size={mode === 'grid' ? 20 : 15} />
          <span className="ext">{fileExt(item)}</span>
        </>
      )}
    </div>
  )
}

function TypeFileIcon({ item, size }: { item: ShelfItemView; size: number }) {
  const typeClass = fileTypeClass(item)
  if (typeClass === 'pdf' || typeClass === 'doc') return <FileText size={size} strokeWidth={1.7} />
  if (typeClass === 'sheet') return <FileSpreadsheet size={size} strokeWidth={1.7} />
  if (typeClass === 'slide') return <Presentation size={size} strokeWidth={1.7} />
  if (typeClass === 'archive') return <FileArchive size={size} strokeWidth={1.7} />
  if (typeClass === 'video') return <FileVideo size={size} strokeWidth={1.7} />
  if (typeClass === 'audio') return <FileAudio size={size} strokeWidth={1.7} />
  if (typeClass === 'image') return <FileImage size={size} strokeWidth={1.7} />
  return <File size={size} strokeWidth={1.7} />
}

function fileExt(item: ShelfItemView): string {
  if (!item.ext) return 'FILE'
  return item.ext.length > 4 ? item.ext.slice(0, 4).toUpperCase() : item.ext.toUpperCase()
}
