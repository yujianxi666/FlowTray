import type { ShelfItemView } from '@shared/types'
import { useAppStore } from '../store'
import { ItemCard } from './ItemCard'

export function ItemList({
  pinned,
  regular,
  orderedIds,
  mode,
  query,
  onRelocate
}: {
  pinned: ShelfItemView[]
  regular: ShelfItemView[]
  orderedIds: string[]
  mode: 'list' | 'grid'
  query: string
  onRelocate: (id: string) => void
}) {
  const settings = useAppStore((state) => state.snapshot?.settings)
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
      {regular.length > 0 ? (
        <>
          {pinned.length > 0 ? (
            <div className="group-label">
              <span>暂存</span>
              <span className="group-count">{regular.length}</span>
              <span className="group-line" />
            </div>
          ) : null}
          {renderGroup(regular)}
        </>
      ) : null}
    </div>
  )
}
