import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  Database,
  FolderOpen,
  Gauge,
  HardDrive,
  Keyboard,
  LockKeyhole,
  Monitor,
  MousePointer2,
  Palette,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Timer,
  Trash2,
  X
} from 'lucide-react'
import type { HostInfo, SettingsSection, StorageUsage } from '@shared/types'
import type { Settings } from '@shared/settings'
import {
  CAPACITY_OPTIONS,
  DRAG_MODIFIER_LABEL,
  SENSITIVE_APPS_DEFAULT,
  SETTINGS_SECTIONS,
  TTL_OPTIONS
} from '@shared/constants'
import { formatAccelerator, formatBytes, formatDateTime } from '@shared/format'
import { useAppStore } from '../store'
import { KeycapGroup, Segmented, Switch } from './ui'
import { cx } from '../lib/utils'

const SECTION_ICONS: Record<SettingsSection, typeof Monitor> = {
  general: Monitor,
  shelf: Palette,
  storage: Database,
  drag: MousePointer2,
  privacy: ShieldCheck,
  shortcuts: Keyboard,
  about: Gauge
}

type UpdateFn = (patch: Partial<Settings>) => Promise<boolean>

export function SettingsPanel() {
  const snapshot = useAppStore((state) => state.snapshot)
  const section = useAppStore((state) => state.settingsSection)
  const setSection = useAppStore((state) => state.setSettingsSection)
  const closeOverlay = useAppStore((state) => state.closeOverlay)
  const setConfirm = useAppStore((state) => state.setConfirm)
  const openOnboarding = useAppStore((state) => state.openOnboarding)
  const pushToast = useAppStore((state) => state.pushToast)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [sensitiveInput, setSensitiveInput] = useState('')
  const [migrating, setMigrating] = useState(false)

  const settings = snapshot?.settings
  const host = snapshot?.host
  const usage = snapshot?.usage

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (useAppStore.getState().confirm) return
      event.preventDefault()
      closeOverlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeOverlay])

  useEffect(() => {
    if (!savedAt) return
    const timer = window.setTimeout(() => setSavedAt(null), 1600)
    return () => window.clearTimeout(timer)
  }, [savedAt])

  const update: UpdateFn = async (patch) => {
    setSaving(true)
    try {
      const result = await window.flowtray.settings.update(patch)
      if (!result.ok) {
        pushToast(result.errors[0]?.message ?? '设置保存失败。', 'error')
        return false
      }
      setSavedAt(Date.now())
      return true
    } finally {
      setSaving(false)
    }
  }

  const chooseStorage = async (): Promise<void> => {
    window.flowtray.window.setInteractionLock(true)
    setMigrating(true)
    try {
      const result = await window.flowtray.settings.chooseStorageDir()
      if (result.ok) pushToast(result.message ?? '存储位置已更新。', 'success')
      else if (result.message && !/取消/.test(result.message)) pushToast(result.message, 'error')
    } finally {
      setMigrating(false)
      window.flowtray.window.setInteractionLock(false)
    }
  }

  const addSensitive = async (): Promise<void> => {
    if (!settings) return
    const value = sensitiveInput.trim().toLowerCase()
    if (!value) return
    if (settings.sensitiveApps.includes(value)) {
      setSensitiveInput('')
      return
    }
    const ok = await update({ sensitiveApps: [...settings.sensitiveApps, value].slice(0, 100) })
    if (ok) {
      setSensitiveInput('')
      pushToast('已加入隐私排除列表。', 'success')
    }
  }

  if (!snapshot || !settings || !host || !usage) {
    return (
      <div className="sheet-overlay settings-panel">
        <div className="sheet-loading">
          <span className="spinner" /> 正在读取设置…
        </div>
      </div>
    )
  }

  const sectionProps = { settings, host, usage, update }
  const privacyProps = {
    ...sectionProps,
    sensitiveInput,
    setSensitiveInput,
    addSensitive,
    removeSensitive: (value: string) =>
      update({ sensitiveApps: settings.sensitiveApps.filter((entry) => entry !== value) }),
    resetSensitive: () => update({ sensitiveApps: [...SENSITIVE_APPS_DEFAULT] }),
    setConfirm
  }

  return (
    <div className="sheet-overlay settings-panel" data-testid="settings-panel">
      <header className="settings-topbar">
        <button type="button" className="sheet-back" onClick={closeOverlay}>
          <ArrowLeft size={14} strokeWidth={1.9} />
          返回
        </button>
        <div className="settings-title">
          设置
          <span>{saving ? '保存中…' : savedAt ? '已自动保存' : '改动即时保存'}</span>
        </div>
        <button type="button" className="icon-button" onClick={closeOverlay} aria-label="关闭设置">
          <X size={14} />
        </button>
      </header>

      <div className="settings-main">
        <nav className="settings-rail" aria-label="设置分类">
          {SETTINGS_SECTIONS.map((entry) => {
            const Icon = SECTION_ICONS[entry.id]
            return (
              <button
                key={entry.id}
                type="button"
                className={cx('rail-item', section === entry.id && 'is-active')}
                onClick={() => setSection(entry.id)}
                title={entry.hint}
              >
                <Icon size={14} strokeWidth={1.8} />
                <span>{entry.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="settings-content" data-testid="settings-content">
          {section === 'general' ? <GeneralSection {...sectionProps} /> : null}
          {section === 'shelf' ? <ShelfSection {...sectionProps} /> : null}
          {section === 'storage' ? (
            <StorageSection
              {...sectionProps}
              chooseStorage={chooseStorage}
              migrating={migrating}
            />
          ) : null}
          {section === 'drag' ? <DragSection {...sectionProps} /> : null}
          {section === 'privacy' ? <PrivacySection {...privacyProps} /> : null}
          {section === 'shortcuts' ? <ShortcutsSection {...sectionProps} /> : null}
          {section === 'about' ? (
            <AboutSection
              {...sectionProps}
              openOnboarding={openOnboarding}
              setConfirm={setConfirm}
              now={snapshot.now}
            />
          ) : null}

          {migrating ? (
            <div className="settings-busy">
              <span className="spinner" />
              正在迁移存储位置，请稍候…
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

interface BaseProps {
  settings: Settings
  host: HostInfo
  usage: StorageUsage
  update: UpdateFn
}

function GeneralSection({ settings, host, update }: BaseProps) {
  return (
    <>
      <SectionHeader
        kicker="GENERAL"
        title="通用"
        copy="决定 FlowTray 如何启动、停靠和呈现。"
      />
      <SettingGroup title="启动">
        <SettingRow
          label="开机自动启动"
          hint={
            settings.launchAsAdmin
              ? '已由“管理员自启动”接管，无需重复开启。'
              : '登录 Windows 后自动在托盘运行。'
          }
        >
          <Switch
            checked={settings.launchAtLogin}
            disabled={settings.launchAsAdmin}
            onChange={(value) => void update({ launchAtLogin: value })}
            label="开机自动启动"
          />
        </SettingRow>
        <SettingRow
          label="管理员自启动"
          hint={
            host.isElevated
              ? '创建计划任务，以管理员身份登录启动。'
              : '需要管理员权限。可先重启为管理员再开启。'
          }
        >
          <Switch
            checked={settings.launchAsAdmin}
            disabled={!host.isElevated}
            onChange={(value) => void update({ launchAsAdmin: value })}
            label="管理员自启动"
          />
        </SettingRow>
        {!host.isElevated ? (
          <div className="inline-note">
            <LockKeyhole size={12} />
            <span>当前为标准权限。</span>
            <button type="button" onClick={() => void window.flowtray.app.restartAsAdmin()}>
              以管理员身份重启
            </button>
          </div>
        ) : (
          <div className="inline-note is-ok">
            <ShieldCheck size={12} />
            当前以管理员身份运行，可拖放到同样以管理员运行的应用。
          </div>
        )}
        {host.autostartWarning ? <div className="inline-error">{host.autostartWarning}</div> : null}
        <SettingRow label="启动时展开" hint="随系统启动时直接显示流转台。">
          <Switch
            checked={settings.openAtLaunch}
            onChange={(value) => void update({ openAtLaunch: value })}
            label="启动时展开"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="外观与位置">
        <SettingRow label="主题" hint="跟随系统，或固定浅色 / 深色。">
          <Segmented
            value={settings.theme}
            onChange={(value) => void update({ theme: value })}
            options={[
              { value: 'system', label: '跟随' },
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' }
            ]}
          />
        </SettingRow>
        <SettingRow label="停靠位置" hint="悬浮窗贴在屏幕的哪一侧。">
          <Segmented
            value={settings.shelfSide}
            onChange={(value) => void update({ shelfSide: value })}
            options={[
              { value: 'right', label: '右侧' },
              { value: 'left', label: '左侧' }
            ]}
          />
        </SettingRow>
        <SettingRow
          label="边缘悬停唤出"
          hint="把鼠标停在屏幕边缘（或拖文件靠近）即可唤出。"
        >
          <Switch
            checked={settings.edgeReveal}
            onChange={(value) => void update({ edgeReveal: value })}
            label="边缘悬停唤出"
          />
        </SettingRow>
        {settings.edgeReveal ? (
          <SettingRow label="触发延迟" hint="停留多久后展开。">
            <Segmented
              value={String(settings.edgeDelayMs)}
              onChange={(value) => void update({ edgeDelayMs: Number(value) })}
              options={[
                { value: '300', label: '快' },
                { value: '450', label: '标准' },
                { value: '700', label: '慢' }
              ]}
            />
          </SettingRow>
        ) : null}
        <SettingRow label="失焦自动收起" hint="点击其他窗口后隐藏；拖放过程中不会收起。">
          <Switch
            checked={settings.hideOnBlur}
            onChange={(value) => void update({ hideOnBlur: value })}
            label="失焦自动收起"
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

function ShelfSection({ settings, host, update }: BaseProps) {
  const presets = [
    { label: '紧凑', width: 360, height: 600 },
    { label: '标准', width: 396, height: 680 },
    { label: '宽绰', width: 452, height: 760 }
  ]
  const active = presets.find(
    (preset) => preset.width === settings.shelfWidth && preset.height === settings.shelfHeight
  )
  return (
    <>
      <SectionHeader
        kicker="SHELF"
        title="悬浮窗"
        copy="控制尺寸、置顶与材质。拖动窗口左边缘也可以实时调整。"
      />
      <SettingGroup title="尺寸">
        <div className="preset-grid">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={cx('preset', active?.label === preset.label && 'is-active')}
              onClick={() =>
                void update({ shelfWidth: preset.width, shelfHeight: preset.height })
              }
            >
              <span className="preset-name">{preset.label}</span>
              <span className="preset-size">
                {preset.width} × {preset.height}
              </span>
            </button>
          ))}
        </div>
        <div className="inline-note">
          <MousePointer2 size={12} />
          当前 {settings.shelfWidth} × {settings.shelfHeight}。拖动左边缘调宽度，左下角调高度。
        </div>
      </SettingGroup>
      <SettingGroup title="窗口">
        <SettingRow label="始终置顶" hint="悬浮窗始终显示在其他应用上方。">
          <Switch
            checked={settings.alwaysOnTop}
            onChange={(value) => void update({ alwaysOnTop: value })}
            label="始终置顶"
          />
        </SettingRow>
        <SettingRow
          label="毛玻璃材质"
          hint={
            host.supportsAcrylic
              ? 'Windows 11 亚克力背景，兼顾透光与可读性。'
              : '需要 Windows 11 22H2 或更高版本。'
          }
        >
          <Switch
            checked={settings.glass}
            disabled={!host.supportsAcrylic}
            onChange={(value) => void update({ glass: value })}
            label="毛玻璃材质"
          />
        </SettingRow>
        <SettingRow label="显示来源应用" hint="在卡片元信息里显示拖入或复制来源。">
          <Switch
            checked={settings.showSource}
            onChange={(value) => void update({ showSource: value })}
            label="显示来源应用"
          />
        </SettingRow>
        <SettingRow label="减少动态效果" hint="关闭卡片入场与展开动画。">
          <Switch
            checked={settings.reduceMotion}
            onChange={(value) => void update({ reduceMotion: value })}
            label="减少动态效果"
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

function StorageSection({
  settings,
  host,
  usage,
  update,
  chooseStorage,
  migrating
}: BaseProps & { chooseStorage: () => Promise<void>; migrating: boolean }) {
  return (
    <>
      <SectionHeader
        kicker="STORAGE"
        title="存储与清理"
        copy="默认只存引用，不复制大文件；到期后自动清理。"
      />
      <SettingGroup title="生命周期">
        <SettingRow
          label="默认有效期"
          hint="只影响之后新增的临时内容，修改不会追溯已有卡片。"
        >
          <Segmented
            value={settings.defaultTtl}
            onChange={(value) => void update({ defaultTtl: value })}
            options={TTL_OPTIONS.map((option) => ({ value: option.value, label: option.short }))}
          />
        </SettingRow>
        <SettingRow label="到期前提醒" hint="到期前 15 分钟在应用内或系统通知提醒。">
          <Switch
            checked={settings.expiryReminder}
            onChange={(value) => void update({ expiryReminder: value })}
            label="到期前提醒"
          />
        </SettingRow>
        <div className="inline-note">
          <Timer size={12} />
          固定项不会自动清理；删除或过期的内容会保留 7 天再彻底移除。
        </div>
      </SettingGroup>

      <SettingGroup title="文件存放">
        <SettingRow
          label="存储方式"
          hint="引用不占空间；副本可防止原文件移动导致失效。"
        >
          <Segmented
            value={settings.storageMode}
            onChange={(value) => void update({ storageMode: value })}
            options={[
              { value: 'reference', label: '仅引用' },
              { value: 'copy', label: '复制副本' }
            ]}
          />
        </SettingRow>
        <SettingRow label="容量上限" hint="仅统计 FlowTray 自己保存的副本与缩略图。">
          <div className="select-wrap">
            <select
              className="select"
              value={String(settings.capacityMb)}
              onChange={(event) => void update({ capacityMb: Number(event.target.value) })}
              aria-label="容量上限"
            >
              {CAPACITY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option === 0 ? '不限容量' : formatBytes(option * 1024 * 1024)}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </div>
        </SettingRow>
        <div className="usage-block">
          <div className="usage-head">
            <span>已用 {formatBytes(usage.storedBytes)}</span>
            <span>
              {usage.capacityBytes === 0 ? '不限' : `上限 ${formatBytes(usage.capacityBytes)}`}
            </span>
          </div>
          <div className="usage-bar">
            <i
              style={{
                width:
                  usage.capacityBytes === 0
                    ? 0
                    : `${Math.min(100, (usage.storedBytes / usage.capacityBytes) * 100)}%`
              }}
            />
          </div>
          <div className="usage-sub">
            引用原文件 {formatBytes(usage.referencedBytes)} · 不计入容量
          </div>
        </div>
        <SettingRow label="存储位置" hint={host.storagePath} vertical>
          <div className="path-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void window.flowtray.settings.openStorageDir()}
            >
              <FolderOpen size={12} />
              打开
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void chooseStorage()}
              disabled={migrating}
            >
              {migrating ? (
                <span className="spinner" style={{ width: 12, height: 12 }} />
              ) : (
                <RefreshCw size={12} />
              )}
              更改…
            </button>
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  )
}

function DragSection({ settings, update }: BaseProps) {
  return (
    <>
      <SectionHeader
        kicker="DRAG & DROP"
        title="拖拽"
        copy="决定拖入、拖出时是复制还是剪切，以及临时切换方式。"
      />
      <SettingGroup title="默认行为">
        <SettingRow
          label="拖入时"
          hint="剪切会把原文件移入 FlowTray 的本地副本，并从原位置移除。"
        >
          <Segmented
            value={settings.dropEffect}
            onChange={(value) => void update({ dropEffect: value })}
            options={[
              { value: 'copy', label: '复制' },
              { value: 'cut', label: '剪切' }
            ]}
          />
        </SettingRow>
        <SettingRow
          label="拖出时"
          hint="剪切会移动源文件；复制会使用安全的临时副本。"
        >
          <Segmented
            value={settings.dragOutEffect}
            onChange={(value) => void update({ dragOutEffect: value })}
            options={[
              { value: 'copy', label: '复制' },
              { value: 'cut', label: '剪切' }
            ]}
          />
        </SettingRow>
        <SettingRow label="临时切换键" hint="拖拽时按住这个键，反转上面的默认行为。">
          <Segmented
            value={settings.dragModifier}
            onChange={(value) => void update({ dragModifier: value })}
            options={[
              { value: 'ctrl', label: 'Ctrl' },
              { value: 'shift', label: 'Shift' },
              { value: 'alt', label: 'Alt' }
            ]}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="安全">
        <SettingRow
          label="安全复制拖出"
          hint="复制拖出时使用硬链接或临时副本，避免目标应用把源文件移走。"
        >
          <Switch
            checked={settings.safeDragCopy}
            onChange={(value) => void update({ safeDragCopy: value })}
            label="安全复制拖出"
          />
        </SettingRow>
        <div className="example-card">
          <div className="example-line">
            拖入 <b>{settings.dropEffect === 'copy' ? '复制' : '剪切'}</b>
            <span>·</span>
            按住 {DRAG_MODIFIER_LABEL[settings.dragModifier]} 变为
            <b>{settings.dropEffect === 'copy' ? '剪切' : '复制'}</b>
          </div>
          <div className="example-line">
            拖出 <b>{settings.dragOutEffect === 'copy' ? '复制' : '剪切'}</b>
            <span>·</span>
            按住 {DRAG_MODIFIER_LABEL[settings.dragModifier]} 变为
            <b>{settings.dragOutEffect === 'copy' ? '剪切' : '复制'}</b>
          </div>
        </div>
      </SettingGroup>
    </>
  )
}

interface PrivacyProps extends BaseProps {
  sensitiveInput: string
  setSensitiveInput: (value: string) => void
  addSensitive: () => Promise<void>
  removeSensitive: (value: string) => Promise<boolean>
  resetSensitive: () => Promise<boolean>
  setConfirm: (kind: 'clear-data' | 'reset-data') => void
}

function PrivacySection({
  settings,
  host,
  update,
  sensitiveInput,
  setSensitiveInput,
  addSensitive,
  removeSensitive,
  resetSensitive,
  setConfirm
}: PrivacyProps) {
  return (
    <>
      <SectionHeader
        kicker="PRIVACY"
        title="剪贴板与隐私"
        copy="没有账号，没有云端，没有遥测。所有内容只留在这台电脑上。"
      />
      <SettingGroup title="剪贴板">
        <SettingRow
          label="自动监听剪贴板"
          hint="默认关闭。开启后会在本机读取剪贴板，新复制的文本、图片或文件会自动暂存。"
        >
          <Switch
            checked={settings.clipboardMonitor}
            onChange={(value) => void update({ clipboardMonitor: value })}
            label="自动监听剪贴板"
          />
        </SettingRow>
        <SettingRow label="剪贴板条目上限" hint="超出时自动清理最旧的未固定剪贴板内容。">
          <Segmented
            value={String(settings.clipboardMaxItems)}
            onChange={(value) => void update({ clipboardMaxItems: Number(value) })}
            options={[
              { value: '50', label: '50' },
              { value: '100', label: '100' },
              { value: '200', label: '200' },
              { value: '500', label: '500' }
            ]}
          />
        </SettingRow>
        {settings.clipboardMonitor ? (
          <div className="inline-note is-ok">
            <ShieldCheck size={12} />
            监听中。前台应用若在排除列表中，内容会被直接跳过。
          </div>
        ) : null}
      </SettingGroup>

      <SettingGroup title="隐私排除应用">
        <div className="setting-block-copy">
          按进程名排除密码管理器等敏感应用。自动监听与快捷键存入都会跳过这些来源。
        </div>
        <div className="chip-editor">
          {settings.sensitiveApps.map((app) => (
            <span key={app} className="editable-chip">
              {app}
              <button
                type="button"
                aria-label={`移除 ${app}`}
                onClick={() => void removeSensitive(app)}
              >
                <X size={9} />
              </button>
            </span>
          ))}
          <div className="chip-input">
            <input
              value={sensitiveInput}
              placeholder="添加进程名"
              onChange={(event) => setSensitiveInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void addSensitive()
                }
              }}
            />
            <button type="button" aria-label="添加排除应用" onClick={() => void addSensitive()}>
              <Plus size={11} />
            </button>
          </div>
        </div>
        <button type="button" className="text-action" onClick={() => void resetSensitive()}>
          恢复默认排除列表
        </button>
      </SettingGroup>

      <SettingGroup title="本地数据">
        <div className="privacy-facts">
          <div>
            <ShieldCheck size={12} />
            日志只记录事件与错误代码，不记录文件内容、完整路径或剪贴板文本。
          </div>
          <div>
            <HardDrive size={12} />
            数据目录：<span title={host.dataPath}>{host.dataPath}</span>
          </div>
          <div>
            <Database size={12} />
            存储目录：<span title={host.storagePath}>{host.storagePath}</span>
          </div>
        </div>
        <div className="path-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void window.flowtray.settings.openDataDir()}
          >
            <FolderOpen size={12} />
            打开数据目录
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void window.flowtray.settings.openLogsDir()}
          >
            <Terminal size={12} />
            日志
          </button>
        </div>
        <div className="danger-zone">
          <div>
            <strong>清除所有暂存内容</strong>
            <span>删除卡片、副本与缩略图，保留设置。应用会重启。</span>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setConfirm('clear-data')}>
            清除…
          </button>
        </div>
        <div className="danger-zone is-strong">
          <div>
            <strong>重置全部本地数据</strong>
            <span>同时清除设置、快捷键、日志，并重新显示引导。不可撤销。</span>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => setConfirm('reset-data')}
          >
            重置…
          </button>
        </div>
      </SettingGroup>
    </>
  )
}

function ShortcutsSection({ settings, host, update }: BaseProps) {
  return (
    <>
      <SectionHeader
        kicker="SHORTCUTS"
        title="快捷键"
        copy="全局快捷键在任何应用中都能使用。更改后立即生效。"
      />
      <SettingGroup title="全局">
        <HotkeyRecorder
          label="呼出 / 隐藏流转台"
          hint="默认 Ctrl + Alt + Space"
          accelerator={settings.hotkeyToggle}
          status={host.hotkeys.toggle}
          onSave={(value) => update({ hotkeyToggle: value })}
        />
        <HotkeyRecorder
          label="从剪贴板暂存"
          hint="默认 Ctrl + Shift + D"
          accelerator={settings.hotkeyCapture}
          status={host.hotkeys.capture}
          onSave={(value) => update({ hotkeyCapture: value })}
        />
      </SettingGroup>
      <SettingGroup title="说明">
        <div className="shortcut-note">
          <Keyboard size={13} />
          <div>
            快捷键被其他应用占用时，FlowTray 会保留原设置并给出错误提示。
            部分系统组合（如 Win 键）无法注册为全局快捷键。
          </div>
        </div>
        <button
          type="button"
          className="text-action"
          onClick={() =>
            void update({
              hotkeyToggle: 'Control+Alt+Space',
              hotkeyCapture: 'Control+Shift+D'
            })
          }
        >
          恢复默认快捷键
        </button>
      </SettingGroup>
      {!host.hotkeys.toggle.ok ? (
        <div className="inline-error">
          当前呼出快捷键未生效：{host.hotkeys.toggle.error ?? '可能被其他应用占用。'}
        </div>
      ) : null}
    </>
  )
}

interface AboutProps extends BaseProps {
  openOnboarding: () => void
  setConfirm: (kind: 'reset-settings') => void
  now: number
}

function AboutSection({ host, openOnboarding, setConfirm, now }: AboutProps) {
  return (
    <>
      <SectionHeader kicker="ABOUT" title="关于" copy="一个安静的本地文件中转坞。" />
      <div className="about-hero">
        <BrandLogo />
        <div>
          <div className="about-name">FlowTray 流转台</div>
          <div className="about-slogan">拖入即流转，用完即清理。</div>
          <div className="about-version">
            版本 {host.version} · Electron {host.electronVersion}
          </div>
        </div>
      </div>
      <div className="about-manifesto">
        <div>
          <ShieldCheck size={13} />
          <div>
            <strong>本地优先</strong>
            <span>没有账号、没有云端同步、没有遥测。文件不会离开你的电脑。</span>
          </div>
        </div>
        <div>
          <Timer size={13} />
          <div>
            <strong>临时与固定</strong>
            <span>默认 24 小时到期清理，重要内容固定后长期保留。</span>
          </div>
        </div>
        <div>
          <Database size={13} />
          <div>
            <strong>引用优先</strong>
            <span>大文件默认只记路径，不复制；需要时再开启副本。</span>
          </div>
        </div>
      </div>
      <SettingGroup title="数据">
        <div className="about-paths">
          <div>
            数据目录 <span title={host.dataPath}>{host.dataPath}</span>
          </div>
          <div>
            日志目录 <span title={host.logsPath}>{host.logsPath}</span>
          </div>
          <div>
            存储目录 <span title={host.storagePath}>{host.storagePath}</span>
          </div>
          <div>
            当前时间 <span>{formatDateTime(now)}</span>
          </div>
        </div>
        <div className="path-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void window.flowtray.settings.openDataDir()}
          >
            <FolderOpen size={12} />
            数据目录
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void window.flowtray.settings.openLogsDir()}
          >
            <Terminal size={12} />
            日志
          </button>
        </div>
      </SettingGroup>
      <SettingGroup title="更多">
        <button type="button" className="wide-action" onClick={openOnboarding}>
          <RefreshCw size={13} />
          重新查看 3 步引导
        </button>
        <button
          type="button"
          className="wide-action is-danger"
          onClick={() => setConfirm('reset-settings')}
        >
          <Trash2 size={13} />
          恢复默认设置
        </button>
      </SettingGroup>
      <div className="about-foot">
        用键盘和鼠标，把注意力留在手头的事上。
        <br />
        FlowTray 不会上传任何内容。
      </div>
    </>
  )
}

function SectionHeader({
  kicker,
  title,
  copy
}: {
  kicker: string
  title: string
  copy: string
}) {
  return (
    <div className="settings-section-head">
      <div className="settings-kicker">{kicker}</div>
      <h1>{title}</h1>
      <p>{copy}</p>
    </div>
  )
}

function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="setting-group">
      <div className="setting-group-title">{title}</div>
      {children}
    </section>
  )
}

function SettingRow({
  label,
  hint,
  children,
  vertical
}: {
  label: string
  hint?: string
  children: ReactNode
  vertical?: boolean
}) {
  return (
    <div className={cx('setting-row', vertical && 'is-vertical')}>
      <div className="setting-label">
        {label}
        {hint ? <span>{hint}</span> : null}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function HotkeyRecorder({
  label,
  hint,
  accelerator,
  status,
  onSave
}: {
  label: string
  hint: string
  accelerator: string
  status: { ok: boolean; error?: string }
  onSave: (value: string) => Promise<boolean>
}) {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pushToast = useAppStore((state) => state.pushToast)
  const saveRef = useRef(onSave)
  saveRef.current = onSave

  useEffect(() => {
    if (!listening) return
    let active = true
    void window.flowtray.shortcuts.suspend()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!active) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        active = false
        setListening(false)
        return
      }
      const value = acceleratorFromEvent(event)
      if (!value) {
        if (!['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
          setError('请使用字母、数字、F1–F24 或方向键，并至少搭配一个修饰键。')
        }
        return
      }
      active = false
      setListening(false)
      setError(null)
      void saveRef.current(value).then((ok) => {
        if (ok) pushToast(`快捷键已更新为 ${formatAccelerator(value)}。`, 'success')
      })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      active = false
      window.removeEventListener('keydown', onKeyDown, true)
      void window.flowtray.shortcuts.resume()
    }
  }, [listening, pushToast])

  return (
    <div className={cx('hotkey-row', listening && 'is-listening')}>
      <div className="hotkey-label">
        {label}
        <span>{listening ? '请按下新的组合键，Esc 取消' : hint}</span>
        {!status.ok ? <em>{status.error ?? '快捷键未生效'}</em> : null}
        {error ? <em>{error}</em> : null}
      </div>
      <button
        type="button"
        className="hotkey-button"
        onClick={() => {
          setError(null)
          setListening((value) => !value)
        }}
      >
        {listening ? (
          <span className="listening-text">按下组合键…</span>
        ) : (
          <KeycapGroup accelerator={accelerator} />
        )}
      </button>
    </div>
  )
}

function acceleratorFromEvent(event: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null
  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push('Control')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (modifiers.length === 0) return null
  const key = mapAcceleratorKey(event.key)
  if (!key) return null
  return [...modifiers, key].join('+')
}

function mapAcceleratorKey(key: string): string | null {
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase()
  if (/^[0-9]$/.test(key)) return key
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key
  const map: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Delete: 'Delete',
    Backspace: 'Backspace',
    Enter: 'Enter',
    Tab: 'Tab'
  }
  return map[key] ?? null
}

function BrandLogo() {
  return (
    <div className="about-logo" aria-hidden="true">
      <svg viewBox="0 0 512 512" width="58" height="58">
        <rect width="512" height="512" rx="112" fill="#101411" />
        <path
          d="M148 258 V332 C148 355 166 373 189 373 H323 C346 373 364 355 364 332 V258"
          fill="none"
          stroke="#D8FF5C"
          strokeWidth="40"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M256 128 V246" stroke="#F4F1E8" strokeWidth="38" strokeLinecap="round" />
        <path
          d="M206 202 L256 252 L306 202"
          stroke="#F4F1E8"
          strokeWidth="38"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </div>
  )
}
