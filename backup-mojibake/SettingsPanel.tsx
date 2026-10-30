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
import type { Settings } from '@shared/settings'
import {
  CAPACITY_OPTIONS,
  DRAG_MODIFIER_LABEL,
  SETTINGS_SECTIONS,
  TTL_OPTIONS
} from '@shared/constants'
import { formatAccelerator, formatBytes, formatDateTime } from '@shared/format'
import type { SettingsSection } from '@shared/types'
import { useAppStore } from '../store'
import { Segmented, Switch, KeycapGroup } from './ui'
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

  const update = async (patch: Partial<Settings>): Promise<boolean> => {
    setSaving(true)
    try {
      const result = await window.flowtray.settings.update(patch)
      if (!result.ok) {
        pushToast(result.errors[0]?.message ?? '璁剧疆淇濆瓨澶辫触銆?, 'error')
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
      if (result.ok) pushToast(result.message ?? '瀛樺偍浣嶇疆宸叉洿鏂般€?, 'success')
      else if (result.message && !/鍙栨秷/.test(result.message)) {
        pushToast(result.message, 'error')
      }
    } finally {
      setMigrating(false)
      window.flowtray.window.setInteractionLock(false)
    }
  }

  const addSensitive = async (): Promise<void> => {
    if (!settings || !sensitiveInput.trim()) return
    const value = sensitiveInput.trim().toLowerCase()
    if (settings.sensitiveApps.includes(value)) {
      setSensitiveInput('')
      return
    }
    const next = [...settings.sensitiveApps, value].slice(0, 100)
    const ok = await update({ sensitiveApps: next })
    if (ok) {
      setSensitiveInput('')
      pushToast('宸插姞鍏ラ殣绉佹帓闄ゅ垪琛ㄣ€?, 'success')
    }
  }

  const removeSensitive = async (value: string): Promise<void> => {
    if (!settings) return
    await update({ sensitiveApps: settings.sensitiveApps.filter((entry) => entry !== value) })
  }

  if (!snapshot || !settings || !host || !usage) {
    return (
      <div className="sheet-overlay settings-panel">
        <div className="sheet-loading">
          <span className="spinner" /> 姝ｅ湪璇诲彇璁剧疆鈥?        </div>
      </div>
    )
  }

  const capacity = settings.capacityMb
  const presets = [
    { label: '绱у噾', width: 360, height: 600 },
    { label: '鏍囧噯', width: 396, height: 680 },
    { label: '瀹界话', width: 452, height: 760 }
  ]
  const activePreset = presets.find(
    (preset) => preset.width === settings.shelfWidth && preset.height === settings.shelfHeight
  )

  return (
    <div className="sheet-overlay settings-panel" data-testid="settings-panel">
      <header className="settings-topbar">
        <button type="button" className="sheet-back" onClick={closeOverlay}>
          <ArrowLeft size={14} strokeWidth={1.9} />
          杩斿洖
        </button>
        <div className="settings-title">
          璁剧疆
          <span>{saving ? '淇濆瓨涓€? : savedAt ? '宸茶嚜鍔ㄤ繚瀛? : '鏀瑰姩鍗虫椂淇濆瓨'}</span>
        </div>
        <button type="button" className="icon-button" onClick={closeOverlay} aria-label="鍏抽棴璁剧疆">
          <X size={14} />
        </button>
      </header>

      <div className="settings-main">
        <nav className="settings-rail" aria-label="璁剧疆鍒嗙被">
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
          {section === 'general' ? (
            <>
              <SectionHeader
                kicker="GENERAL"
                title="閫氱敤"
                copy="鍐冲畾 FlowTray 濡備綍鍚姩銆佸仠闈犲拰鍛堢幇銆?
              />
              <SettingGroup title="鍚姩">
                <SettingRow
                  label="寮€鏈鸿嚜鍔ㄥ惎鍔?
                  hint={
                    settings.launchAsAdmin
                      ? '宸茬敱鈥滅鐞嗗憳鑷惎鍔ㄢ€濇帴绠★紝鏃犻渶閲嶅寮€鍚€?
                      : '鐧诲綍 Windows 鍚庤嚜鍔ㄥ湪鎵樼洏杩愯銆?
                  }
                >
                  <Switch
                    checked={settings.launchAtLogin}
                    disabled={settings.launchAsAdmin}
                    onChange={(value) => void update({ launchAtLogin: value })}
                    label="寮€鏈鸿嚜鍔ㄥ惎鍔?
                  />
                </SettingRow>
                <SettingRow
                  label="绠＄悊鍛樿嚜鍚姩"
                  hint={
                    host.isElevated
                      ? '鍒涘缓璁″垝浠诲姟锛屼互绠＄悊鍛樿韩浠界櫥褰曞惎鍔ㄣ€?
                      : '闇€瑕佺鐞嗗憳鏉冮檺銆傚彲鍏堥噸鍚负绠＄悊鍛樺啀寮€鍚€?
                  }
                >
                  <Switch
                    checked={settings.launchAsAdmin}
                    disabled={!host.isElevated}
                    onChange={(value) => void update({ launchAsAdmin: value })}
                    label="绠＄悊鍛樿嚜鍚姩"
                  />
                </SettingRow>
                {!host.isElevated ? (
                  <div className="inline-note">
                    <LockKeyhole size={12} />
                    <span>褰撳墠涓烘爣鍑嗘潈闄愩€?/span>
                    <button
                      type="button"
                      onClick={() => void window.flowtray.app.restartAsAdmin()}
                    >
                      浠ョ鐞嗗憳韬唤閲嶅惎
                    </button>
                  </div>
                ) : (
                  <div className="inline-note is-ok">
                    <ShieldCheck size={12} />
                    褰撳墠浠ョ鐞嗗憳韬唤杩愯锛屽彲鎷栨斁鍒板悓鏍蜂互绠＄悊鍛樿繍琛岀殑搴旂敤銆?                  </div>
                )}
                {host.autostartWarning ? (
                  <div className="inline-error">{host.autostartWarning}</div>
                ) : null}
                <SettingRow label="鍚姩鏃跺睍寮€" hint="闅忕郴缁熷惎鍔ㄦ椂鐩存帴鏄剧ず娴佽浆鍙般€?>
                  <Switch
                    checked={settings.openAtLaunch}
                    onChange={(value) => void update({ openAtLaunch: value })}
                    label="鍚姩鏃跺睍寮€"
                  />
                </SettingRow>
              </SettingGroup>

              <SettingGroup title="澶栬涓庝綅缃?>
                <SettingRow label="涓婚" hint="璺熼殢绯荤粺锛屾垨鍥哄畾娴呰壊 / 娣辫壊銆?>
                  <Segmented
                    value={settings.theme}
                    onChange={(value) => void update({ theme: value })}
                    options={[
                      { value: 'system', label: '璺熼殢' },
                      { value: 'dark', label: '娣辫壊' },
                      { value: 'light', label: '娴呰壊' }
                    ]}
                  />
                </SettingRow>
                <SettingRow label="鍋滈潬浣嶇疆" hint="鎮诞绐楄创鍦ㄥ睆骞曠殑鍝竴渚с€?>
                  <Segmented
                    value={settings.shelfSide}
                    onChange={(value) => void update({ shelfSide: value })}
                    options={[
                      { value: 'right', label: '鍙充晶' },
                      { value: 'left', label: '宸︿晶' }
                    ]}
                  />
                </SettingRow>
                <SettingRow
                  label="杈圭紭鎮仠鍞ゅ嚭"
                  hint="鎶婇紶鏍囧仠鍦ㄥ睆骞曡竟缂橈紙鎴栨嫋鏂囦欢闈犺繎锛夊嵆鍙敜鍑恒€?
                >
                  <Switch
                    checked={settings.edgeReveal}
                    onChange={(value) => void update({ edgeReveal: value })}
                    label="杈圭紭鎮仠鍞ゅ嚭"
                  />
                </SettingRow>
                {settings.edgeReveal ? (
                  <SettingRow label="瑙﹀彂寤惰繜" hint="鍋滅暀澶氫箙鍚庡睍寮€銆?>
                    <Segmented
                      value={String(settings.edgeDelayMs)}
                      onChange={(value) => void update({ edgeDelayMs: Number(value) })}
                      options={[
                        { value: '300', label: '蹇? },
                        { value: '450', label: '鏍囧噯' },
                        { value: '700', label: '鎱? }
                      ]}
                    />
                  </SettingRow>
                ) : null}
                <SettingRow
                  label="澶辩劍鑷姩鏀惰捣"
                  hint="鐐瑰嚮鍏朵粬绐楀彛鍚庨殣钘忥紱鎷栨斁杩囩▼涓笉浼氭敹璧枫€?
                >
                  <Switch
                    checked={settings.hideOnBlur}
                    onChange={(value) => void update({ hideOnBlur: value })}
                    label="澶辩劍鑷姩鏀惰捣"
                  />
                </SettingRow>
              </SettingGroup>
            </>
          ) : null}

          {section === 'shelf' ? (
            <>
              <SectionHeader
                kicker="SHELF"
                title="鎮诞绐?
                copy="鎺у埗灏哄銆佺疆椤朵笌鏉愯川銆傛嫋鍔ㄧ獥鍙ｅ乏杈圭紭涔熷彲浠ュ疄鏃惰皟鏁淬€?
              />
              <SettingGroup title="灏哄">
                <div className="preset-grid">
                  {presets.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={cx('preset', activePreset?.label === preset.label && 'is-active')}
                      onClick={() =>
                        void update({ shelfWidth: preset.width, shelfHeight: preset.height })
                      }
                    >
                      <span className="preset-name">{preset.label}</span>
                      <span className="preset-size">
                        {preset.width} 脳 {preset.height}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="inline-note">
                  <MousePointer2 size={12} />
                  褰撳墠 {settings.shelfWidth} 脳 {settings.shelfHeight}銆傛嫋鍔ㄥ乏杈圭紭璋冨搴︼紝宸︿笅瑙掕皟楂樺害銆?                </div>
              </SettingGroup>
              <SettingGroup title="绐楀彛">
                <SettingRow label="濮嬬粓缃《" hint="鎮诞绐楀缁堟樉绀哄湪鍏朵粬搴旂敤涓婃柟銆?>
                  <Switch
                    checked={settings.alwaysOnTop}
                    onChange={(value) => void update({ alwaysOnTop: value })}
                    label="濮嬬粓缃《"
                  />
                </SettingRow>
                <SettingRow
                  label="姣涚幓鐠冩潗璐?
                  hint={
                    host.supportsAcrylic
                      ? 'Windows 11 浜氬厠鍔涜儗鏅紝鍏奸【閫忓厜涓庡彲璇绘€с€?
                      : '闇€瑕?Windows 11 22H2 鎴栨洿楂樼増鏈€?
                  }
                >
                  <Switch
                    checked={settings.glass}
                    disabled={!host.supportsAcrylic}
                    onChange={(value) => void update({ glass: value })}
                    label="姣涚幓鐠冩潗璐?
                  />
                </SettingRow>
                <SettingRow label="鏄剧ず鏉ユ簮搴旂敤" hint="鍦ㄥ崱鐗囧厓淇℃伅閲屾樉绀烘嫋鍏?澶嶅埗鏉ユ簮銆?>
                  <Switch
                    checked={settings.showSource}
                    onChange={(value) => void update({ showSource: value })}
                    label="鏄剧ず鏉ユ簮搴旂敤"
                  />
                </SettingRow>
                <SettingRow label="鍑忓皯鍔ㄦ€佹晥鏋? hint="鍏抽棴鍗＄墖鍏ュ満涓庡睍寮€鍔ㄧ敾銆?>
                  <Switch
                    checked={settings.reduceMotion}
                    onChange={(value) => void update({ reduceMotion: value })}
                    label="鍑忓皯鍔ㄦ€佹晥鏋?
                  />
                </SettingRow>
              </SettingGroup>
            </>
          ) : null}

          {section === 'storage' ? (
            <>
              <SectionHeader
                kicker="STORAGE"
                title="瀛樺偍涓庢竻鐞?
                copy="榛樿鍙瓨寮曠敤锛屼笉澶嶅埗澶ф枃浠讹紱鍒版湡鍚庤嚜鍔ㄦ竻鐞嗐€?
              />
              <SettingGroup title="鐢熷懡鍛ㄦ湡">
                <SettingRow label="榛樿鏈夋晥鏈? hint="鍙奖鍝嶄箣鍚庢柊澧炵殑涓存椂鍐呭锛屼慨鏀逛笉浼氳拷婧凡鏈夊崱鐗囥€?>
                  <Segmented
                    value={settings.defaultTtl}
                    onChange={(value) => void update({ defaultTtl: value })}
                    options={TTL_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.short
                    }))}
                  />
                </SettingRow>
                <SettingRow label="鍒版湡鍓嶆彁閱? hint="鍒版湡鍓?15 鍒嗛挓鍦ㄥ簲鐢ㄥ唴鎴栫郴缁熼€氱煡鎻愰啋銆?>
                  <Switch
                    checked={settings.expiryReminder}
                    onChange={(value) => void update({ expiryReminder: value })}
                    label="鍒版湡鍓嶆彁閱?
                  />
                </SettingRow>
                <div className="inline-note">
                  <Timer size={12} />
                  鍥哄畾椤逛笉浼氳嚜鍔ㄦ竻鐞嗭紱鍒犻櫎鎴栬繃鏈熺殑鍐呭浼氫繚鐣?7 澶╁啀褰诲簳绉婚櫎銆?                </div>
              </SettingGroup>

              <SettingGroup title="鏂囦欢瀛樻斁">
                <SettingRow label="瀛樺偍鏂瑰紡" hint="寮曠敤涓嶅崰绌洪棿锛涘壇鏈彲闃叉鍘熸枃浠剁Щ鍔ㄥ鑷村け鏁堛€?>
                  <Segmented
                    value={settings.storageMode}
                    onChange={(value) => void update({ storageMode: value })}
                    options={[
                      { value: 'reference', label: '浠呭紩鐢? },
                      { value: 'copy', label: '澶嶅埗鍓湰' }
                    ]}
                  />
                </SettingRow>
                <SettingRow label="瀹归噺涓婇檺" hint="浠呯粺璁?FlowTray 鑷繁淇濆瓨鐨勫壇鏈笌缂╃暐鍥俱€?>
                  <div className="select-wrap">
                    <select
                      className="select"
                      value={String(capacity)}
                      onChange={(event) =>
                        void update({ capacityMb: Number(event.target.value) })
                      }
                      aria-label="瀹归噺涓婇檺"
                    >
                      {CAPACITY_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option === 0 ? '涓嶉檺瀹归噺' : formatBytes(option * 1024 * 1024)}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={12} />
                  </div>
                </SettingRow>
                <div className="usage-block">
                  <div className="usage-head">
                    <span>宸茬敤 {formatBytes(usage.storedBytes)}</span>
                    <span>
                      {usage.capacityBytes === 0
                        ? '涓嶉檺'
                        : `涓婇檺 ${formatBytes(usage.capacityBytes)}`}
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
                    寮曠敤鍘熸枃浠?{formatBytes(usage.referencedBytes)} 路 涓嶈鍏ュ閲?                  </div>
                </div>
                <SettingRow label="瀛樺偍浣嶇疆" hint={host.storagePath} vertical>
                  <div className="path-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void window.flowtray.settings.openStorageDir()}
                    >
                      <FolderOpen size={12} />
                      鎵撳紑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void chooseStorage()}
                      disabled={migrating}
                    >
                      {migrating ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <RefreshCw size={12} />}
                      鏇存敼鈥?                    </button>
                  </div>
                </SettingRow>
              </SettingGroup>
            </>
          ) : null}

          {section === 'drag' ? (
            <>
              <SectionHeader
                kicker="DRAG & DROP"
                title="鎷栨嫿"
                copy="鍐冲畾鎷栧叆銆佹嫋鍑烘椂鏄鍒惰繕鏄壀鍒囷紝浠ュ強涓存椂鍒囨崲鏂瑰紡銆?
              />
              <SettingGroup title="榛樿琛屼负">
                <SettingRow label="鎷栧叆鏃? hint="鍓垏浼氭妸鍘熸枃浠剁Щ鍏?FlowTray 鐨勬湰鍦板壇鏈紝骞朵粠鍘熶綅缃Щ闄ゃ€?>
                  <Segmented
                    value={settings.dropEffect}
                    onChange={(value) => void update({ dropEffect: value })}
                    options={[
                      { value: 'copy', label: '澶嶅埗' },
                      { value: 'cut', label: '鍓垏' }
                    ]}
                  />
                </SettingRow>
                <SettingRow label="鎷栧嚭鏃? hint="鍓垏浼氱Щ鍔ㄦ簮鏂囦欢锛涘鍒朵細浣跨敤瀹夊叏鐨勪复鏃跺壇鏈€?>
                  <Segmented
                    value={settings.dragOutEffect}
                    onChange={(value) => void update({ dragOutEffect: value })}
                    options={[
                      { value: 'copy', label: '澶嶅埗' },
                      { value: 'cut', label: '鍓垏' }
                    ]}
                  />
                </SettingRow>
                <SettingRow label="涓存椂鍒囨崲閿? hint="鎷栨嫿鏃舵寜浣忚繖涓敭锛屽弽杞笂闈㈢殑榛樿琛屼负銆?>
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
              <SettingGroup title="瀹夊叏">
                <SettingRow
                  label="瀹夊叏澶嶅埗鎷栧嚭"
                  hint="澶嶅埗鎷栧嚭鏃朵娇鐢ㄧ‖閾炬帴鎴栦复鏃跺壇鏈紝閬垮厤鐩爣搴旂敤鎶婃簮鏂囦欢绉昏蛋銆?
                >
                  <Switch
                    checked={settings.safeDragCopy}
                    onChange={(value) => void update({ safeDragCopy: value })}
                    label="瀹夊叏澶嶅埗鎷栧嚭"
                  />
                </SettingRow>
                <div className="example-card">
                  <div className="example-line">
                    鎷栧叆 <b>{settings.dropEffect === 'copy' ? '澶嶅埗' : '鍓垏'}</b>
                    <span>路</span>
                    鎸変綇 {DRAG_MODIFIER_LABEL[settings.dragModifier]} 鍙樹负
                    <b>{settings.dropEffect === 'copy' ? '鍓垏' : '澶嶅埗'}</b>
                  </div>
                  <div className="example-line">
                    鎷栧嚭 <b>{settings.dragOutEffect === 'copy' ? '澶嶅埗' : '鍓垏'}</b>
                    <span>路</span>
                    鎸変綇 {DRAG_MODIFIER_LABEL[settings.dragModifier]} 鍙樹负
                    <b>{settings.dragOutEffect === 'copy' ? '鍓垏' : '澶嶅埗'}</b>
                  </div>
                </div>
              </SettingGroup>
            </>
          ) : null}

          {section === 'privacy' ? (
            <>
              <SectionHeader
                kicker="PRIVACY"
                title="鍓创鏉夸笌闅愮"
                copy="娌℃湁璐﹀彿锛屾病鏈変簯绔紝娌℃湁閬ユ祴銆傛墍鏈夊唴瀹瑰彧鐣欏湪杩欏彴鐢佃剳涓娿€?
              />
              <SettingGroup title="鍓创鏉?>
                <SettingRow
                  label="鑷姩鐩戝惉鍓创鏉?
                  hint="榛樿鍏抽棴銆傚紑鍚悗浼氬湪鏈満璇诲彇鍓创鏉匡紝鏂板鍒剁殑鏂囨湰銆佸浘鐗囨垨鏂囦欢浼氳嚜鍔ㄦ殏瀛樸€?
                >
                  <Switch
                    checked={settings.clipboardMonitor}
                    onChange={(value) => void update({ clipboardMonitor: value })}
                    label="鑷姩鐩戝惉鍓创鏉?
                  />
                </SettingRow>
                <SettingRow label="鍓创鏉挎潯鐩笂闄? hint="瓒呭嚭鏃惰嚜鍔ㄦ竻鐞嗘渶鏃х殑鏈浐瀹氬壀璐存澘鍐呭銆?>
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
                    鐩戝惉涓€傚綋鍓嶅墠鍙板簲鐢ㄨ嫢鍦ㄦ帓闄ゅ垪琛ㄤ腑锛屽唴瀹逛細琚洿鎺ヨ烦杩囥€?                  </div>
                ) : null}
              </SettingGroup>

              <SettingGroup title="闅愮鎺掗櫎搴旂敤">
                <div className="setting-block-copy">
                  鎸夎繘绋嬪悕鎺掗櫎瀵嗙爜绠＄悊鍣ㄧ瓑鏁忔劅搴旂敤銆傚壀璐存澘鐩戝惉涓庡揩鎹烽敭瀛樺叆閮戒細璺宠繃杩欎簺鏉ユ簮銆?                </div>
                <div className="chip-editor">
                  {settings.sensitiveApps.map((app) => (
                    <span key={app} className="editable-chip">
                      {app}
                      <button
                        type="button"
                        aria-label={`绉婚櫎 ${app}`}
                        onClick={() => void removeSensitive(app)}
                      >
                        <X size={9} />
                      </button>
                    </span>
                  ))}
                  <div className="chip-input">
                    <input
                      value={sensitiveInput}
                      placeholder="娣诲姞杩涚▼鍚?
                      onChange={(event) => setSensitiveInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void addSensitive()
                        }
                      }}
                    />
                    <button type="button" aria-label="娣诲姞鎺掗櫎搴旂敤" onClick={() => void addSensitive()}>
                      <Plus size={11} />
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => void update({ sensitiveApps: [] })}
                >
                  娓呯┖鎺掗櫎鍒楄〃
                </button>
              </SettingGroup>

              <SettingGroup title="鏈湴鏁版嵁">
                <div className="privacy-facts">
                  <div>
                    <ShieldCheck size={12} />
                    鏃ュ織鍙褰曚簨浠朵笌閿欒浠ｇ爜锛屼笉璁板綍鏂囦欢鍐呭銆佸畬鏁磋矾寰勬垨鍓创鏉挎枃鏈€?                  </div>
                  <div>
                    <HardDrive size={12} />
                    鏁版嵁鐩綍锛?span title={host.dataPath}>{host.dataPath}</span>
                  </div>
                  <div>
                    <Database size={12} />
                    瀛樺偍鐩綍锛?span title={host.storagePath}>{host.storagePath}</span>
                  </div>
                </div>
                <div className="path-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void window.flowtray.settings.openDataDir()}
                  >
                    <FolderOpen size={12} />
                    鎵撳紑鏁版嵁鐩綍
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void window.flowtray.settings.openLogsDir()}
                  >
                    <Terminal size={12} />
                    鏃ュ織
                  </button>
                </div>
                <div className="danger-zone">
                  <div>
                    <strong>娓呴櫎鎵€鏈夋殏瀛樺唴瀹?/strong>
                    <span>鍒犻櫎鍗＄墖銆佸壇鏈笌缂╃暐鍥撅紝淇濈暀璁剧疆銆傚簲鐢ㄤ細閲嶅惎銆?/span>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => setConfirm('clear-data')}>
                    娓呴櫎鈥?                  </button>
                </div>
                <div className="danger-zone is-strong">
                  <div>
                    <strong>閲嶇疆鍏ㄩ儴鏈湴鏁版嵁</strong>
                    <span>鍚屾椂娓呴櫎璁剧疆銆佸揩鎹烽敭銆佹棩蹇楋紝骞堕噸鏂版樉绀哄紩瀵笺€備笉鍙挙閿€銆?/span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => setConfirm('reset-data')}
                  >
                    閲嶇疆鈥?                  </button>
                </div>
              </SettingGroup>
            </>
          ) : null}

          {section === 'shortcuts' ? (
            <>
              <SectionHeader
                kicker="SHORTCUTS"
                title="蹇嵎閿?
                copy="鍏ㄥ眬蹇嵎閿湪浠讳綍搴旂敤涓兘鑳戒娇鐢ㄣ€傛洿鏀瑰悗绔嬪嵆鐢熸晥銆?
              />
              <SettingGroup title="鍏ㄥ眬">
                <HotkeyRecorder
                  label="鍛煎嚭 / 闅愯棌娴佽浆鍙?
                  hint="榛樿 Ctrl + Shift + Space"
                  accelerator={settings.hotkeyToggle}
                  status={host.hotkeys.toggle}
                  onSave={(value) => update({ hotkeyToggle: value })}
                />
                <HotkeyRecorder
                  label="浠庡壀璐存澘鏆傚瓨"
                  hint="榛樿 Ctrl + Shift + D"
                  accelerator={settings.hotkeyCapture}
                  status={host.hotkeys.capture}
                  onSave={(value) => update({ hotkeyCapture: value })}
                />
              </SettingGroup>
              <SettingGroup title="璇存槑">
                <div className="shortcut-note">
                  <Keyboard size={13} />
                  <div>
                    蹇嵎閿鍏朵粬搴旂敤鍗犵敤鏃讹紝FlowTray 浼氫繚鐣欏師璁剧疆骞剁粰鍑洪敊璇彁绀恒€?                    閮ㄥ垎绯荤粺缁勫悎锛堝 Win 閿級鏃犳硶娉ㄥ唽涓哄叏灞€蹇嵎閿€?                  </div>
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
                  鎭㈠榛樿蹇嵎閿?                </button>
              </SettingGroup>
              {!host.hotkeys.toggle.ok ? (
                <div className="inline-error">
                  褰撳墠鍛煎嚭蹇嵎閿湭鐢熸晥锛歿host.hotkeys.toggle.error ?? '鍙兘琚叾浠栧簲鐢ㄥ崰鐢ㄣ€?}
                </div>
              ) : null}
            </>
          ) : null}

          {section === 'about' ? (
            <>
              <SectionHeader kicker="ABOUT" title="鍏充簬" copy="涓€涓畨闈欑殑鏈湴鏂囦欢涓浆鍧炪€? />
              <div className="about-hero">
                <BrandLogo />
                <div>
                  <div className="about-name">FlowTray 娴佽浆鍙?/div>
                  <div className="about-slogan">鎷栧叆鍗虫祦杞紝鐢ㄥ畬鍗虫竻鐞嗐€?/div>
                  <div className="about-version">
                    鐗堟湰 {host.version} 路 Electron {host.electronVersion}
                  </div>
                </div>
              </div>
              <div className="about-manifesto">
                <div>
                  <ShieldCheck size={13} />
                  <div>
                    <strong>鏈湴浼樺厛</strong>
                    <span>娌℃湁璐﹀彿銆佹病鏈変簯绔悓姝ャ€佹病鏈夐仴娴嬨€傛枃浠朵笉浼氱寮€浣犵殑鐢佃剳銆?/span>
                  </div>
                </div>
                <div>
                  <Timer size={13} />
                  <div>
                    <strong>涓存椂涓庡浐瀹?/strong>
                    <span>榛樿 24 灏忔椂鍒版湡娓呯悊锛岄噸瑕佸唴瀹瑰浐瀹氬悗闀挎湡淇濈暀銆?/span>
                  </div>
                </div>
                <div>
                  <Database size={13} />
                  <div>
                    <strong>寮曠敤浼樺厛</strong>
                    <span>澶ф枃浠堕粯璁ゅ彧璁拌矾寰勶紝涓嶅鍒讹紱闇€瑕佹椂鍐嶅紑鍚壇鏈€?/span>
                  </div>
                </div>
              </div>
              <SettingGroup title="鏁版嵁">
                <div className="about-paths">
                  <div>鏁版嵁鐩綍 <span title={host.dataPath}>{host.dataPath}</span></div>
                  <div>鏃ュ織鐩綍 <span title={host.logsPath}>{host.logsPath}</span></div>
                  <div>鏈€杩戞鏌?<span>{formatDateTime(snapshot.now)}</span></div>
                </div>
                <div className="path-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void window.flowtray.settings.openDataDir()}
                  >
                    <FolderOpen size={12} />
                    鏁版嵁鐩綍
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void window.flowtray.settings.openLogsDir()}
                  >
                    <Terminal size={12} />
                    鏃ュ織
                  </button>
                </div>
              </SettingGroup>
              <SettingGroup title="鏇村">
                <button type="button" className="wide-action" onClick={openOnboarding}>
                  <RefreshCw size={13} />
                  閲嶆柊鏌ョ湅 3 姝ュ紩瀵?                </button>
                <button
                  type="button"
                  className="wide-action is-danger"
                  onClick={() => setConfirm('reset-settings')}
                >
                  <Trash2 size={13} />
                  鎭㈠榛樿璁剧疆
                </button>
              </SettingGroup>
              <div className="about-foot">
                鐢ㄩ敭鐩樺拰榧犳爣锛屾妸娉ㄦ剰鍔涚暀鍦ㄦ墜澶寸殑浜嬩笂銆?                <br />
                FlowTray 涓嶄細涓婁紶浠讳綍鍐呭銆?              </div>
            </>
          ) : null}

          {migrating ? (
            <div className="settings-busy">
              <span className="spinner" />
              姝ｅ湪杩佺Щ瀛樺偍浣嶇疆锛岃绋嶅€欌€?            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ kicker, title, copy }: { kicker: string; title: string; copy: string }) {
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
          setError('璇蜂娇鐢ㄥ瓧姣嶃€佹暟瀛椼€丗1鈥揊24 鎴栨柟鍚戦敭锛屽苟鑷冲皯鎼厤涓€涓慨楗伴敭銆?)
        }
        return
      }
      active = false
      setListening(false)
      setError(null)
      void saveRef.current(value).then((ok) => {
        if (ok) pushToast(`蹇嵎閿凡鏇存柊涓?${formatAccelerator(value)}銆俙, 'success')
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
        <span>{listening ? '璇锋寜涓嬫柊鐨勭粍鍚堥敭锛孍sc 鍙栨秷' : hint}</span>
        {!status.ok ? <em>{status.error ?? '蹇嵎閿湭鐢熸晥'}</em> : null}
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
          <span className="listening-text">鎸変笅缁勫悎閿€?/span>
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

