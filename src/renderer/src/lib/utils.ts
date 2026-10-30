import type { DragEffect, ItemType, ShelfItemView } from '@shared/types'
import { fileExtension, formatBytes, formatShortTtl, humanTypeLabel } from '@shared/format'

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export function isFileLike(item: Pick<ShelfItemView, 'type'>): boolean {
  return item.type === 'file' || item.type === 'folder' || item.type === 'image'
}

export function typeGroup(item: Pick<ShelfItemView, 'type'>): 'file' | 'image' | 'text' | 'url' {
  if (item.type === 'folder') return 'file'
  return item.type
}

export function typeLabel(item: ShelfItemView): string {
  if (item.type === 'file' || item.type === 'image') {
    return humanTypeLabel(item.type, item.ext)
  }
  return humanTypeLabel(item.type, null)
}

export function sourceLabel(item: ShelfItemView): string | null {
  if (item.sourceApp) return item.sourceApp
  if (item.source === 'clipboard') return '剪贴板'
  if (item.source === 'drop') return '本地拖入'
  return null
}

export function metaLine(item: ShelfItemView): string[] {
  const values: string[] = [typeLabel(item)]
  if (item.type === 'text') {
    values.push(`${formatCount(item.textLength ?? 0)} 字`)
  } else if (item.type === 'url') {
    try {
      values.push(new URL(item.url ?? '').hostname)
    } catch {
      values.push('链接')
    }
  } else if (item.type === 'folder') {
    values.push('文件夹')
  } else {
    values.push(formatBytes(item.size))
  }
  return values
}

function formatCount(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function ttlLabel(item: ShelfItemView): string {
  if (item.pinned) return '已固定'
  if (item.status === 'missing') return '已失效'
  if (item.expiresAt == null) return '永久'
  if (item.expiresAt <= Date.now()) return '已到期'
  return formatShortTtl(Math.max(0, item.expiresAt - Date.now()))
}

export function ttlTone(item: ShelfItemView): 'normal' | 'soon' | 'pinned' | 'missing' | 'never' {
  if (item.pinned) return 'pinned'
  if (item.status === 'missing') return 'missing'
  if (item.expiresAt == null) return 'never'
  const remaining = item.expiresAt - Date.now()
  if (remaining <= 15 * 60_000) return 'soon'
  return 'normal'
}

export function fileExtLabel(ext: string | null): string {
  if (!ext) return 'FILE'
  return ext.length > 4 ? ext.slice(0, 4).toUpperCase() : ext.toUpperCase()
}

export function matchesQuery(item: ShelfItemView, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return true
  const haystack = [
    item.name,
    item.preview ?? '',
    item.url ?? '',
    item.sourceApp ?? '',
    item.path ?? '',
    item.ext ?? ''
  ]
    .join('\n')
    .toLowerCase()
  return query.split(/\s+/).every((token) => haystack.includes(token))
}

export function itemTypeMatches(
  item: ShelfItemView,
  filter: 'all' | 'file' | 'image' | 'text' | 'url'
): boolean {
  if (filter === 'all') return true
  if (filter === 'file') return item.type === 'file' || item.type === 'folder'
  return item.type === filter
}

export function modifierPressed(
  event: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  modifier: 'ctrl' | 'shift' | 'alt'
): boolean {
  if (modifier === 'ctrl') return event.ctrlKey
  if (modifier === 'shift') return event.shiftKey
  return event.altKey
}

export function invertedEffect(base: DragEffect, modifierHeld: boolean): DragEffect {
  if (!modifierHeld) return base
  return base === 'copy' ? 'cut' : 'copy'
}

export function effectText(effect: DragEffect): string {
  return effect === 'copy' ? '复制' : '剪切'
}

export function buildDragGhost(count: number, effect: DragEffect): HTMLCanvasElement {
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = 168 * scale
  canvas.height = 52 * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.scale(scale, scale)
  ctx.clearRect(0, 0, 168, 52)
  const gradient = ctx.createLinearGradient(0, 0, 168, 52)
  gradient.addColorStop(0, '#171D18')
  gradient.addColorStop(1, '#0D110E')
  ctx.fillStyle = gradient
  roundRect(ctx, 1, 1, 166, 50, 13)
  ctx.fill()
  ctx.strokeStyle = 'rgba(216,255,92,0.45)'
  ctx.lineWidth = 1
  roundRect(ctx, 1, 1, 166, 50, 13)
  ctx.stroke()
  ctx.fillStyle = '#D8FF5C'
  roundRect(ctx, 10, 10, 32, 32, 9)
  ctx.fill()
  ctx.fillStyle = '#151B0A'
  ctx.font = '600 13px "Segoe UI", "Microsoft YaHei UI", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(count), 26, 27)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#F2F0E6'
  ctx.font = '600 12.5px "Segoe UI", "Microsoft YaHei UI", sans-serif'
  ctx.fillText(`${count} 项`, 52, 20)
  ctx.fillStyle = 'rgba(242,240,230,0.58)'
  ctx.font = '10.5px "Segoe UI", "Microsoft YaHei UI", sans-serif'
  ctx.fillText(`${effectText(effect)}拖出`, 52, 36)
  return canvas
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
}

export function buildDragIcon(count: number, effect: DragEffect): string {
  return buildDragGhost(count, effect).toDataURL('image/png')
}

export function fileTypeClass(item: ShelfItemView): string {
  if (item.type === 'folder') return 'folder'
  if (item.type === 'image') return 'image'
  if (item.type === 'text') return 'text'
  if (item.type === 'url') return 'url'
  const ext = fileExtension(item.name) ?? ''
  if (['pdf'].includes(ext)) return 'pdf'
  if (['doc', 'docx', 'rtf', 'pages'].includes(ext)) return 'doc'
  if (['xls', 'xlsx', 'csv', 'numbers'].includes(ext)) return 'sheet'
  if (['ppt', 'pptx', 'key'].includes(ext)) return 'slide'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive'
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(ext)) return 'audio'
  if (['exe', 'msi', 'bat', 'cmd', 'ps1'].includes(ext)) return 'app'
  return 'file'
}

export function displayPath(path: string | null, max = 58): string {
  if (!path) return '—'
  if (path.length <= max) return path
  const head = path.slice(0, Math.ceil(max * 0.45))
  const tail = path.slice(-Math.floor(max * 0.45))
  return `${head}…${tail}`
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return map[character]
  })
}

export function countLabel(count: number): string {
  if (count > 999) return '999+'
  return String(count)
}

export type { ItemType }
