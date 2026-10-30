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
import { formatAccelerator } from '@shared/format'
import { useAppStore } from '../store'
import { BrandMark, KeycapGroup, Switch } from './ui'
import { cx } from '../lib/utils'

const STEPS = [
  { title: '涓€涓揩鎹烽敭锛岄殢鍙殢鍒?, kicker: '01 / 鍞ゅ嚭' },
  { title: '鎶婅鐢ㄧ殑涓滆タ锛屽厛鏀捐繘鏉?, kicker: '02 / 鏆傚瓨' },
  { title: '鎷栧嚭鍘伙紝鐢ㄥ畬鍗宠蛋', kicker: '03 / 娴佽浆' }
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (useAppStore.getState().confirm) return
      event.preventDefault()
      void finish(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const finish = async (skipped = false): Promise<void> => {
    setSaving(true)
    const result = await window.flowtray.settings.update({ onboardingDone: true })
    setSaving(false)
    if (!result.ok) {
      pushToast(result.errors[0]?.message ?? '鏃犳硶淇濆瓨寮曞鐘舵€併€?, 'error')
      return
    }
    closeOverlay()
    if (!skipped) pushToast('鍑嗗濂戒簡銆傛妸涓滆タ鎷栬繘鏉ワ紝寮€濮嬩娇鐢?FlowTray銆?, 'success')
  }

  const tryClipboard = async (): Promise<void> => {
    const result = await window.flowtray.items.addClipboard()
    if (result.ok) {
      setSampleSaved(true)
      pushToast('鍓创鏉垮唴瀹瑰凡瀛樺叆鏆傚瓨鍙般€?, 'success')
    }
  }

  const setLaunchAtLogin = async (value: boolean): Promise<void> => {
    const result = await window.flowtray.settings.update({ launchAtLogin: value })
    if (!result.ok) pushToast(result.errors[0]?.message ?? '璁剧疆寮€鏈哄惎鍔ㄥけ璐ャ€?, 'error')
  }

  return (
    <div className="sheet-overlay onboarding" data-testid="onboarding">
      <header className="onboarding-top">
        <div className="onboarding-brand">
          <BrandMark size={24} />
          <span>FlowTray</span>
        </div>
        <button type="button" className="onboarding-skip" onClick={() => void finish(true)}>
          璺宠繃
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
              鏃犺浣犳鍦ㄥ摢涓簲鐢紝鎸変笅
              <span className="inline-keys">
                <KeycapGroup accelerator={hotkey} />
              </span>
              锛屾祦杞彴灏变細浠庡睆骞曡竟缂樻粦鍑恒€傚啀鎸変竴娆″嵆鍙殣钘忋€?            </>
          ) : null}
          {step === 1 ? (
            <>
              浠庤祫婧愮鐞嗗櫒銆佹祻瑙堝櫒鎴栬亰澶╃獥鍙ｆ嫋鍏ユ枃浠躲€佸浘鐗囥€佹枃鏈拰閾炬帴銆?              <br />
              澶ф枃浠堕粯璁ゅ彧璁板綍璺緞锛屼笉浼氬鍒讹紱涓存椂鍐呭 24 灏忔椂鍚庤嚜鍔ㄦ竻鐞嗐€?            </>
          ) : null}
          {step === 2 ? (
            <>
              鎶婂崱鐗囨嫋鍒板井淇°€侀偖浠躲€佹祻瑙堝櫒鎴栬祫婧愮鐞嗗櫒锛屾澗鎵嬪嵆鐢ㄣ€?              <br />
              鏂囨湰涓庡浘鐗囦篃鍙互鐐逛竴涓嬪鍒躲€傚浐瀹氶噸瑕佸唴瀹癸紝灏变笉浼氳鑷姩娓呯悊銆?            </>
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
              {sampleSaved ? '宸插瓨鍏ワ紝瀹屾垚寮曞鍚庡彲鏌ョ湅' : '璇曡瘯瀛樺叆褰撳墠鍓创鏉?}
            </button>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="onboarding-privacy">
            <ShieldCheck size={13} />
            <div>
              <strong>鏈湴浼樺厛</strong>
              娌℃湁璐﹀彿銆佹病鏈変笂浼犮€佹病鏈夐仴娴嬨€傛墍鏈夊唴瀹瑰彧淇濆瓨鍦ㄨ繖鍙扮數鑴戜笂銆?            </div>
          </div>
        ) : null}
      </div>

      <footer className="onboarding-foot">
        {step === 2 ? (
          <div className="onboarding-launch">
            <span>寮€鏈烘椂鑷姩杩愯 FlowTray</span>
            <Switch
              checked={Boolean(settings?.launchAtLogin)}
              onChange={(value) => void setLaunchAtLogin(value)}
              label="寮€鏈烘椂鑷姩杩愯"
            />
          </div>
        ) : (
          <div className="onboarding-note">蹇嵎閿彲鍦ㄨ缃腑闅忔椂鏇存敼</div>
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
              涓婁竴姝?            </button>
          ) : (
            <span />
          )}
          {step < 2 ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setStep(step + 1)}>
              涓嬩竴姝?              <ArrowRight size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void finish()}
              disabled={saving}
            >
              {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Sparkles size={12} />}
              寮€濮嬩娇鐢?            </button>
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
      <div className="wake-hint">鍛煎嚭 / 闅愯棌</div>
    </div>
  )
}

function StepDrop() {
  return (
    <div className="onboard-art drop-art">
      <div className="drop-files">
        <div className="drop-file f1">
          <FileText size={14} />
          <span>鏂规.pdf</span>
        </div>
        <div className="drop-file f2">
          <Image size={14} />
          <span>鎴浘.png</span>
        </div>
        <div className="drop-file f3">
          <Folder size={14} />
          <span>绱犳潗</span>
        </div>
        <div className="drop-file f4">
          <Link2 size={14} />
          <span>閾炬帴</span>
        </div>
        <div className="drop-file f5">
          <FileArchive size={14} />
          <span>褰掓。.zip</span>
        </div>
      </div>
      <div className="drop-tray">
        <div className="drop-tray-mouth" />
        <div className="drop-tray-label">
          <BrandMark size={20} />
          <span>鏆傚瓨鍙?/span>
        </div>
        <div className="drop-tray-bar" />
      </div>
      <div className="drop-arrow">
        <span />
        <span />
        <span />
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
          <strong>3 椤瑰唴瀹?/strong>
          <span>鎷栧姩鍒扮洰鏍囧簲鐢?/span>
        </div>
      </div>
      <div className="flow-arrow">
        <ArrowRight size={15} />
      </div>
      <div className="flow-targets">
        <div className="flow-target">
          <span className="flow-dot is-green" />
          寰俊
        </div>
        <div className="flow-target">
          <span className="flow-dot is-blue" />
          閭欢
        </div>
        <div className="flow-target">
          <span className="flow-dot is-amber" />
          娴忚鍣?        </div>
        <div className="flow-target">
          <span className="flow-dot is-gray" />
          璧勬簮绠＄悊鍣?        </div>
      </div>
    </div>
  )
}

