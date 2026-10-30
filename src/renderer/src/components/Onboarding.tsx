import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ClipboardPaste,
  FileArchive,
  FileText,
  Folder,
  Image,
  Link2,
  ShieldCheck,
  Sparkles,
  X
} from 'lucide-react'
import { useAppStore } from '../store'
import { BrandMark, KeycapGroup, Switch } from './ui'
import { cx } from '../lib/utils'

const STEPS = [
  { title: '一个快捷键，随叫随到', kicker: '01 / 唤出' },
  { title: '把要用的东西，先放进来', kicker: '02 / 暂存' },
  { title: '拖出去，用完即走', kicker: '03 / 流转' }
]

export function Onboarding() {
  const snapshot = useAppStore((state) => state.snapshot)
  const closeOverlay = useAppStore((state) => state.closeOverlay)
  const pushToast = useAppStore((state) => state.pushToast)
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [sampleSaved, setSampleSaved] = useState(false)
  const settings = snapshot?.settings
  const hotkey = settings?.hotkeyToggle ?? 'Control+Alt+Space'

  async function finish(skipped = false): Promise<void> {
    setSaving(true)
    const result = await window.flowtray.settings.update({ onboardingDone: true })
    setSaving(false)
    if (!result.ok) {
      pushToast(result.errors[0]?.message ?? '无法保存引导状态。', 'error')
      return
    }
    closeOverlay()
    if (!skipped) {
      pushToast('准备好了。把东西拖进来，开始使用 FlowTray。', 'success')
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (useAppStore.getState().confirm) return
      event.preventDefault()
      void finish(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // finish intentionally reads the latest store through hooks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tryClipboard = async (): Promise<void> => {
    const result = await window.flowtray.items.addClipboard()
    if (result.ok) setSampleSaved(true)
  }

  const setLaunchAtLogin = async (value: boolean): Promise<void> => {
    const result = await window.flowtray.settings.update({ launchAtLogin: value })
    if (!result.ok) pushToast(result.errors[0]?.message ?? '设置开机启动失败。', 'error')
  }

  return (
    <div className="sheet-overlay onboarding" data-testid="onboarding">
      <header className="onboarding-top">
        <div className="onboarding-brand">
          <BrandMark size={24} />
          <span>FlowTray</span>
        </div>
        <button type="button" className="onboarding-skip" onClick={() => void finish(true)}>
          跳过
          <X size={12} />
        </button>
      </header>

      <div className="onboarding-stage">
        <div className="onboarding-kicker">{STEPS[step].kicker}</div>
        <h1 className="onboarding-title">{STEPS[step].title}</h1>

        {step === 0 ? <StepWake hotkey={hotkey} /> : null}
        {step === 1 ? <StepDrop /> : null}
        {step === 2 ? <StepFlow /> : null}

        <div className="onboarding-copy">
          {step === 0 ? (
            <>
              无论你正在哪个应用，按下
              <span className="inline-keys">
                <KeycapGroup accelerator={hotkey} />
              </span>
              ，
              <br />
              流转台就会从屏幕边缘滑出。再按一次即可隐藏。
            </>
          ) : null}
          {step === 1 ? (
            <>
              从资源管理器、浏览器或聊天窗口拖入。
              <br />
              文件、图片、文本和链接都能接住；
              <br />
              大文件默认只记路径，24 小时后自动清理。
            </>
          ) : null}
          {step === 2 ? (
            <>
              把卡片拖到微信、邮件、浏览器或资源管理器。
              <br />
              文本与图片一点即复制。固定重要内容，不参与自动清理。
            </>
          ) : null}
        </div>

        {step === 1 ? (
          <div className="onboarding-try">
            <button
              type="button"
              className={cx('btn btn-sm', sampleSaved && 'is-done')}
              onClick={() => void tryClipboard()}
            >
              {sampleSaved ? <Sparkles size={12} /> : <ClipboardPaste size={12} />}
              {sampleSaved ? '已存入，完成引导后可查看' : '试试存入当前剪贴板'}
            </button>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="onboarding-privacy">
            <ShieldCheck size={13} />
            <div>
              <strong>本地优先</strong>
              没有账号、没有上传、没有遥测。所有内容只保存在这台电脑上。
            </div>
          </div>
        ) : null}
      </div>

      <footer className="onboarding-foot">
        {step === 2 ? (
          <div className="onboarding-launch">
            <span>开机时自动运行 FlowTray</span>
            <Switch
              checked={Boolean(settings?.launchAtLogin)}
              onChange={(value) => void setLaunchAtLogin(value)}
              label="开机时自动运行"
            />
          </div>
        ) : (
          <div className="onboarding-note">快捷键可在设置中随时更改</div>
        )}
        <div className="onboarding-progress">
          {STEPS.map((_, index) => (
            <span key={index} className={cx(index === step && 'is-active')} />
          ))}
        </div>
        <div className="onboarding-actions">
          {step > 0 ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep(step - 1)}>
              <ArrowLeft size={12} />
              上一步
            </button>
          ) : (
            <span />
          )}
          {step < 2 ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setStep(step + 1)}
            >
              下一步
              <ArrowRight size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void finish()}
              disabled={saving}
            >
              {saving ? (
                <span className="spinner" style={{ width: 12, height: 12 }} />
              ) : (
                <Sparkles size={12} />
              )}
              开始使用
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}

function StepWake({ hotkey }: { hotkey: string }) {
  return (
    <div className="onboard-art wake-art">
      <div className="wake-desktop">
        <div className="wake-window">
          <span />
          <span />
          <span />
        </div>
        <div className="wake-edge" />
        <div className="wake-shelf">
          <BrandMark size={22} />
          <div className="wake-lines">
            <i />
            <i />
            <i />
          </div>
        </div>
      </div>
      <div className="wake-keys">
        <KeycapGroup accelerator={hotkey} />
      </div>
      <div className="wake-hint">呼出 / 隐藏</div>
    </div>
  )
}

function StepDrop() {
  return (
    <div className="onboard-art drop-art">
      <div className="drop-files">
        <div className="drop-file f1">
          <FileText size={14} />
          <span>方案.pdf</span>
        </div>
        <div className="drop-file f2">
          <Image size={14} />
          <span>截图.png</span>
        </div>
        <div className="drop-file f3">
          <Folder size={14} />
          <span>素材</span>
        </div>
        <div className="drop-file f4">
          <Link2 size={14} />
          <span>链接</span>
        </div>
        <div className="drop-file f5">
          <FileArchive size={14} />
          <span>归档.zip</span>
        </div>
      </div>
      <div className="drop-arrow">
        <span />
        <span />
        <span />
      </div>
      <div className="drop-tray">
        <div className="drop-tray-mouth" />
        <div className="drop-tray-label">
          <BrandMark size={20} />
          <span>暂存台</span>
        </div>
        <div className="drop-tray-bar" />
      </div>
    </div>
  )
}

function StepFlow() {
  return (
    <div className="onboard-art flow-art">
      <div className="flow-card">
        <BrandMark size={22} />
        <div>
          <strong>3 项内容</strong>
          <span>拖动到目标应用</span>
        </div>
      </div>
      <div className="flow-arrow">
        <ArrowRight size={15} />
      </div>
      <div className="flow-targets">
        <div className="flow-target">
          <span className="flow-dot is-green" />
          微信
        </div>
        <div className="flow-target">
          <span className="flow-dot is-blue" />
          邮件
        </div>
        <div className="flow-target">
          <span className="flow-dot is-amber" />
          浏览器
        </div>
        <div className="flow-target">
          <span className="flow-dot is-gray" />
          资源管理器
        </div>
      </div>
    </div>
  )
}
