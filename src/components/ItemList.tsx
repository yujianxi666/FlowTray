import type { ShelfItemView } from '@shared/types'
import { ArrowLeft, ChevronRight, ClipboardList, FolderOpen } from 'lucide-react'
import { useAppStore } from '../store'
import { ItemCard } from './ItemCard'

export function ItemList({
  pinned,
  regular,
  orderedIds,
  mode,
  query,
  onRelocate,
  clipboardCount = 0,
  folders = [],
  activeFolder = null
}: {
  pinned: ShelfItemView[]
  regular: ShelfItemView[]
  orderedIds: string[]
  mode: 'list' | 'grid'
  query: string
  onRelocate: (id: string) => void
  clipboardCount?: number
  folders?: { label: string; count: number }[]
  activeFolder?: string | null
}) {
  const settings = useAppStore((state) => state.snapshot?.settings)
  const typeFilter = useAppStore((state) => state.typeFilter)
  const setTypeFilter = useAppStore((state) => state.setTypeFilter)
  const clipboardMode = typeFilter === 'clipboard'
  const setFolderGroup = useAppStore((state) => state.setFolderGroup)
  const folderMode = activeFolder !== null
  const selection = useAppStore((state) => state.selection)
  const showSource = settings?.showSource ?? true
  const renderGroup = (items: ShelfItemView[]) => (
    <div className={mode === 'grid' ? 'item-grid' : 'item-list'}>
      {items.map((item) => (
        <ItemCard
          key={item.id}
          item={item}
          mode={mode}
          query={query}
          selected={selection.includes(item.id)}
          orderedIds={orderedIds}
          showSource={showSource}
          onRelocate={onRelocate}
        />
      ))}
    </div>
  )

  return (
    <div className="scroll-area" data-testid="item-scroll">
      {pinned.length > 0 ? (
        <>
          <div className="group-label is-pinned">
            <span>已固定</span>
            <span className="group-count">{pinned.length}</span>
            <span className="group-line" />
          </div>
          {renderGroup(pinned)}
        </>
      ) : null}
      {folderMode ? (
        <button
          type="button"
          className="collection-back"
          onClick={() => setFolderGroup(null)}
        >
          <ArrowLeft size={13} strokeWidth={2} />
          返回全部
        </button>
      ) : null}
      {regular.length > 0 ? (
        <>
          {pinned.length > 0 || clipboardMode || folderMode ? (
            <div className="group-label">
              <span>{folderMode ? `文件夹：${activeFolder}` : clipboardMode ? '剪贴板合集' : '暂存'}</span>
              <span className="group-count">{regular.length}</span>
              <span className="group-line" />
            </div>
          ) : null}
          {renderGroup(regular)}
        </>
      ) : null}
      {clipboardCount > 0 ? (
        <button
          type="button"
          className="collection-card"
          data-testid="clipboard-collection"
          onClick={() => setTypeFilter('clipboard')}
        >
          <span className="collection-icon">
            <ClipboardList size={16} strokeWidth={1.8} />
          </span>
          <span className="collection-text">
            <span className="collection-title">剪贴板合集</span>
            <span className="collection-meta">
              {clipboardCount} 项 · 复制的内容自动收在这里，不占主列表
            </span>
          </span>
          <ChevronRight size={14} strokeWidth={2} className="collection-arrow" />
        </button>
      ) : null}
      {folders.map((folder) => (
        <button
          key={folder.label}
          type="button"
          className="collection-card"
          data-testid="folder-collection"
          onClick={() => setFolderGroup(folder.label)}
        >
          <span className="collection-icon">
            <FolderOpen size={16} strokeWidth={1.8} />
          </span>
          <span className="collection-text">
            <span className="collection-title">文件夹：{folder.label}</span>
            <span className="collection-meta">
              {folder.count} 项 · 拖入时展开的子项，点开查看
            </span>
          </span>
          <ChevronRight size={14} strokeWidth={2} className="collection-arrow" />
        </button>
      ))}
    </div>
  )
}
