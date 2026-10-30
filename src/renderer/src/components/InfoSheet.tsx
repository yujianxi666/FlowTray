import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  History,
  Link2,
  Pin,
  PinOff,
  Trash2,
  TriangleAlert,
  Type,
  X
} from 'lucide-react'
import type { ShelfItemDetail } from '@shared/types'
import { formatBytes, formatDateTime, formatCountdown } from '@shared/format'
import { useAppStore } from '../store'
import { cx, isFileLike, sourceLabel, typeLabel } from '../lib/utils'

export function InfoSheet() {
  const infoId = useAppStore((state) => state.infoId)
  const closeOverlay = useAppStore((state) => state.closeOverlay)
  const pushToast = useAppStore((state) => state.pushToast)
  const [detail, setDetail] = useState<ShelfItemDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!infoId) return
    let active = true
    setLoading(true)
    window.flowtray.items
      .detail(infoId)
      .then((value) => {
        if (!active) return
        setDetail(value)
        if (!value) closeOverlay()
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [infoId, closeOverlay])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeOverlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeOverlay])

  if (!infoId) return null

  const copy = async (): Promise<void> => {
    const result = await window.flowtray.items.copy([infoId], 'auto')
    if (result.ok) pushToast(result.message ?? '已复制。', 'success')
    else pushToast(result.message ?? '复制失败。', 'error')
  }

  const copyPath = async (): Promise<void> => {
    const result = await window.flowtray.items.copy([infoId], 'path')
    if (result.ok) pushToast('路径已复制。', 'success')
    else pushToast(result.message ?? '复制路径失败。', 'error')
  }

  const pin = async (): Promise<void> => {
    if (!detail) return
    const result = await window.flowtray.items.update(detail.id, { pinned: !detail.pinned })
    if (result.ok) {
      setDetail(await window.flowtray.items.detail(detail.id))
      pushToast(!detail.pinned ? '已固定。' : '已取消固定。', 'success')
    }
  }

  const remove = async (): Promise<void> => {
    if (!detail) return
    const result = await window.flowtray.items.remove([detail.id])
    if (result.ok) {
      closeOverlay()
      pushToast('已删除，可在下方撤销。', 'info')
    }
  }

  const relocate = async (): Promise<void> => {
    if (!detail) return
    const result = await window.flowtray.items.relocate(detail.id)
    if (result.ok) {
      pushToast('已重新定位。', 'success')
      const next = await window.flowtray.items.detail(detail.id)
      setDetail(next)
    } else if (result.errors[0]?.code !== 'invalid') {
      pushToast(result.errors[0]?.message ?? '重新定位失败。', 'error')
    }
  }

  const restore = async (): Promise<void> => {
    if (!detail) return
    const result = await window.flowtray.items.restoreOriginal(detail.id)
    if (result.ok) {
      pushToast(result.message ?? '已放回原处。', 'success')
      setDetail(await window.flowtray.items.detail(detail.id))
    } else {
      pushToast(result.errors[0]?.message ?? '放回失败。', 'error')
    }
  }

  const open = async (): Promise<void> => {
    if (!detail) return
    if (detail.type === 'text') {
      await copy()
      return
    }
    const result = await window.flowtray.items.openItem(detail.id)
    if (!result.ok) pushToast(result.message ?? '打开失败。', 'error')
  }

  const reveal = async (): Promise<void> => {
    if (!detail) return
    const result = await window.flowtray.items.reveal(detail.id)
    if (!result.ok) pushToast(result.message ?? '定位失败。', 'error')
  }

  return (
    <div className="sheet-overlay info-sheet" data-testid="info-sheet">
      <header className="sheet-topbar">
        <button type="button" className="sheet-back" onClick={closeOverlay}>
          <ArrowLeft size={14} strokeWidth={1.9} />
          返回
        </button>
        <span className="sheet-title">内容信息</span>
        <button type="button" className="icon-button" onClick={closeOverlay} aria-label="关闭">
          <X size={14} />
        </button>
      </header>

      {loading ? (
        <div className="sheet-loading">
          <span className="spinner" />
          正在读取…
        </div>
      ) : detail ? (
        <div className="sheet-scroll info-scroll">
          {detail.status === 'missing' ? (
            <div className="info-alert">
              <TriangleAlert size={13} />
              <div>
                <strong>文件已失效</strong>
                原文件可能被移动、重命名或删除。可以重新定位，或删除这张卡片。
              </div>
            </div>
          ) : null}

          <div className="info-hero">
            <div className={`info-thumb type-${detail.type}`}>
              {detail.thumbUrl ? (
                <img src={detail.thumbUrl} alt="" draggable={false} />
              ) : (
                <span className="info-thumb-fallback">
                  {detail.type === 'text' ? (
                    <Type size={24} strokeWidth={1.5} />
                  ) : detail.type === 'url' ? (
                    <Link2 size={26} />
                  ) : (
                    detail.ext?.toUpperCase() ?? 'FILE'
                  )}
                </span>
              )}
            </div>
            <div className="info-title-block">
              <div className="info-name" title={detail.name}>
                {detail.name}
              </div>
              <div className="info-sub">
                {typeLabel(detail)} ·{' '}
                {detail.type === 'text'
                  ? `${detail.textLength ?? 0} 字`
                  : detail.type === 'url'
                    ? '链接'
                    : formatBytes(detail.size)}
                {detail.pinned ? ' · 已固定' : ''}
              </div>
            </div>
          </div>

          <div className="info-actions">
            {detail.status === 'missing' && isFileLike(detail) ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void relocate()}>
                <FolderSearch size={12} />
                重新定位
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void open()}>
                {detail.type === 'text' ? <Copy size={12} /> : detail.type === 'url' ? <ExternalLink size={12} /> : <FolderOpen size={12} />}
                {detail.type === 'text' ? '复制文本' : detail.type === 'url' ? '打开链接' : '打开'}
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => void copy()}>
              <Copy size={12} />
              复制
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void pin()}>
              {detail.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              {detail.pinned ? '取消固定' : '固定'}
            </button>
            {isFileLike(detail) && detail.status !== 'missing' ? (
              <button type="button" className="btn btn-sm" onClick={() => void reveal()}>
                <FolderOpen size={12} />
                定位
              </button>
            ) : null}
          </div>

          {detail.type === 'text' ? (
            <section className="info-section">
              <div className="section-kicker">内容 · {detail.textLength ?? 0} 字</div>
              <pre className="info-text">{detail.textContent}</pre>
              <button type="button" className="btn btn-sm info-copy-text" onClick={() => void copy()}>
                <Copy size={12} /> 复制全文
              </button>
            </section>
          ) : null}

          {detail.type === 'url' ? (
            <section className="info-section">
              <div className="section-kicker">链接</div>
              <button type="button" className="info-link" onClick={() => void open()}>
                <Link2 size={13} />
                <span>{detail.url}</span>
                <ExternalLink size={11} />
              </button>
            </section>
          ) : null}

          <section className="info-section">
            <div className="section-kicker">详情</div>
            <div className="info-rows">
              <MetaRow label="类型" value={typeLabel(detail)} />
              <MetaRow label="大小" value={detail.type === 'text' ? `${detail.textLength ?? 0} 字` : formatBytes(detail.size)} />
              <MetaRow label="来源" value={sourceLabel(detail) ?? '手动添加'} />
              <MetaRow label="创建时间" value={formatDateTime(detail.createdAt)} />
              <MetaRow
                label="到期时间"
                value={
                  detail.pinned
                    ? '已固定 · 不会自动清理'
                    : detail.expiresAt == null
                      ? '永久保留'
                      : `${formatDateTime(detail.expiresAt)}（${formatCountdown(detail.expiresAt - Date.now())}）`
                }
              />
              <MetaRow
                label="存储方式"
                value={
                  detail.type === 'text' || detail.type === 'url'
                    ? '本地数据库'
                    : detail.storageMode === 'copy'
                      ? detail.movedIn
                        ? '已移入 FlowTray（可放回）'
                        : 'FlowTray 副本'
                      : '引用原文件（不复制）'
                }
              />
              <MetaRow
                label="状态"
                value={
                  detail.status === 'missing'
                    ? '失效'
                    : detail.pinned
                      ? '已固定'
                      : '正常'
                }
                tone={detail.status === 'missing' ? 'danger' : 'normal'}
              />
            </div>
          </section>

          {detail.path ? (
            <section className="info-section">
              <div className="section-kicker">位置</div>
              <div className="info-path">
                <code title={detail.path}>{detail.path}</code>
                <button type="button" className="icon-button" title="复制路径" onClick={() => void copyPath()}>
                  <Copy size={12} />
                </button>
              </div>
              {detail.originalPath && detail.originalPath !== detail.path ? (
                <div className="info-path-note">原始位置：{detail.originalPath}</div>
              ) : null}
            </section>
          ) : null}

          {detail.movedIn ? (
            <button type="button" className="btn btn-sm info-restore" onClick={() => void restore()}>
              <History size={12} />
              放回原位置
            </button>
          ) : null}
          {detail.status === 'missing' ? (
            <button type="button" className="btn btn-sm info-restore" onClick={() => void relocate()}>
              <FolderSearch size={12} />
              重新定位文件
            </button>
          ) : null}

          <div className="info-footer">
            <button type="button" className="info-delete" onClick={() => void remove()}>
              <Trash2 size={12} />
              删除这条内容
            </button>
          </div>
        </div>
      ) : (
        <div className="sheet-loading">内容已不存在。</div>
      )}
    </div>
  )
}

function MetaRow({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'normal' | 'danger'
}) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className={cx('info-value', tone === 'danger' && 'is-danger')}>{value}</span>
    </div>
  )
}
