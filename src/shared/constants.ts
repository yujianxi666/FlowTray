import type { SettingsSection, TtlOption } from './types'

export const APP_NAME = 'FlowTray'
export const APP_NAME_CN = '流转台'
export const APP_SLOGAN = '拖入即流转，用完即清理。'
export const APP_ID = 'com.flowtray.desktop'
export const APP_VERSION = '0.1.0'

export const TTL_OPTIONS: Array<{ value: TtlOption; label: string; short: string; ms: number | null }> = [
  { value: '1h', label: '1 小时', short: '1 小时', ms: 60 * 60 * 1000 },
  { value: '24h', label: '24 小时', short: '1 天', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7 天', short: '7 天', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: 'never', label: '永不', short: '永不', ms: null }
]

export function ttlToMs(ttl: TtlOption): number | null {
  return TTL_OPTIONS.find((option) => option.value === ttl)?.ms ?? null
}

export function computeExpiresAt(ttl: TtlOption, now = Date.now()): number | null {
  const ms = ttlToMs(ttl)
  return ms == null ? null : now + ms
}

export const CAPACITY_OPTIONS = [512, 1024, 2048, 5120, 10240, 0] as const

export const SENSITIVE_APPS_DEFAULT = [
  'keepass',
  'keepassxc',
  '1password',
  'bitwarden',
  'lastpass',
  'dashlane',
  'enpass',
  'roboform',
  'protonpass',
  'nordpass',
  'keeper',
  'keepersecurity',
  'sticky password',
  'authenticator',
  'credentialmanager',
  'credentialuibroker',
  'logonui',
  'cmdkey'
]

export const SENSITIVE_TITLES_DEFAULT = [
  'password',
  'passwort',
  'contraseña',
  '密码',
  '凭据',
  'credentials',
  'vault',
  'authenticator',
  '密码管理'
]

export const SENSITIVE_APP_HINT =
  '按进程名排除（不含 .exe），一行一个。剪贴板自动监听时，来自这些应用的复制内容不会被收录。'

export const SETTINGS_SECTIONS: Array<{
  id: SettingsSection
  label: string
  hint: string
}> = [
  { id: 'general', label: '通用', hint: '启动、主题与停靠' },
  { id: 'shelf', label: '悬浮窗', hint: '尺寸、置顶与外观' },
  { id: 'storage', label: '存储与清理', hint: '有效期、容量与位置' },
  { id: 'drag', label: '拖拽', hint: '复制、剪切与切换键' },
  { id: 'privacy', label: '剪贴板与隐私', hint: '监听、排除与数据' },
  { id: 'about', label: '关于', hint: '版本与本地数据' }
]

export const DRAG_MODIFIER_LABEL: Record<'ctrl' | 'shift' | 'alt', string> = {
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt'
}

export const MAX_TEXT_CHARS = 2_000_000
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024
export const MAX_DROP_ITEMS = 200
export const MAX_ITEMS_TOTAL = 3000
export const UNDO_WINDOW_MS: Record<'clear' | 'delete' | 'expiry', number> = {
  clear: 30_000,
  delete: 10_000,
  expiry: 60_000
}
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const EXPIRY_REMINDER_MS = 15 * 60 * 1000
