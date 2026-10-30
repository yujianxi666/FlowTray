const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number, precision = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : precision
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${UNITS[unit]}`
}

export function formatCountdown(ms: number | null): string {
  if (ms == null) return '永久'
  if (ms <= 0) return '已到期'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (ms < minute) return '即将过期'
  if (ms < hour) return `${Math.ceil(ms / minute)} 分钟后过期`
  if (ms < day) return `${Math.ceil(ms / hour)} 小时后过期`
  return `${Math.ceil(ms / day)} 天后过期`
}

export function formatShortTtl(ms: number | null): string {
  if (ms == null) return '永久'
  if (ms <= 0) return '已到期'
  if (ms < 60_000) return '<1 分钟'
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)} 分钟`
  if (ms < 86_400_000) return `${Math.ceil(ms / 3_600_000)} 小时`
  return `${Math.ceil(ms / 86_400_000)} 天`
}

export function formatRelativePast(timestamp: number, now = Date.now()): string {
  const delta = Math.max(0, now - timestamp)
  if (delta < 45_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  return formatDate(timestamp)
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date)
}

const ACCELERATOR_LABELS: Record<string, string> = {
  Control: 'Ctrl',
  Ctrl: 'Ctrl',
  CommandOrControl: 'Ctrl',
  Command: '⌘',
  Meta: 'Win',
  Super: 'Win',
  Alt: 'Alt',
  Shift: 'Shift',
  Space: '空格',
  Enter: 'Enter',
  Return: 'Enter',
  Escape: 'Esc',
  Esc: 'Esc',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Plus: '+',
  Minus: '-',
  PrintScreen: 'PrtSc'
}

export function acceleratorParts(accelerator: string): string[] {
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (ACCELERATOR_LABELS[part]) return ACCELERATOR_LABELS[part]
      if (/^F\d{1,2}$/.test(part)) return part
      if (part.length === 1) return part.toUpperCase()
      return part
    })
}

export function formatAccelerator(accelerator: string): string {
  return acceleratorParts(accelerator).join(' + ')
}

export function truncateMiddle(value: string, max = 56): string {
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return null
  return name.slice(dot + 1).toLowerCase()
}

export function humanTypeLabel(type: string, ext: string | null): string {
  switch (type) {
    case 'folder':
      return '文件夹'
    case 'image':
      return ext ? ext.toUpperCase() : '图片'
    case 'text':
      return '文本'
    case 'url':
      return '链接'
    default:
      return ext ? ext.toUpperCase() : '文件'
  }
}
