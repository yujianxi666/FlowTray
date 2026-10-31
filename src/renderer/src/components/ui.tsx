import type { ReactNode, CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'

export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      style={{ borderRadius: Math.round(size * 0.22) }}
    >
      <defs>
        <linearGradient id={`ft-bg-${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#171C17" />
          <stop offset="1" stopColor="#0B0E0C" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="512" height="512" rx="112" fill={`url(#ft-bg-${size})`} />
      <rect
        x="1.5"
        y="1.5"
        width="509"
        height="509"
        rx="111"
        fill="none"
        stroke="#F4F1E8"
        strokeOpacity="0.1"
        strokeWidth="3"
      />
      <path
        d="M148 258 V332 C148 355 166 373 189 373 H323 C346 373 364 355 364 332 V258"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="40"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M256 128 V246"
        fill="none"
        stroke="#F4F1E8"
        strokeWidth="38"
        strokeLinecap="round"
      />
      <path
        d="M206 202 L256 252 L306 202"
        fill="none"
        stroke="#F4F1E8"
        strokeWidth="38"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim()
  if (!needle) return <>{text}</>
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'ig'))
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === needle.toLowerCase() ? (
          <mark key={index}>{part}</mark>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      className={`switch ${checked ? 'is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel
}: {
  value: T
  options: Array<{ value: T; label: ReactNode; title?: string }>
  onChange: (value: T) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.title}
          disabled={disabled}
          className={`segmented-item ${value === option.value ? 'is-active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function SectionTitle({
  children,
  hint
}: {
  children: ReactNode
  hint?: string
}) {
  return (
    <div className="section-title-row">
      <div className="section-title">{children}</div>
      {hint ? <div className="section-hint">{hint}</div> : null}
    </div>
  )
}

export function Modal({
  children,
  onClose,
  className,
  labelledBy
}: {
  children: ReactNode
  onClose: () => void
  className?: string
  labelledBy?: string
}) {
  return (
    <div className={`modal-scrim ${className ?? ''}`} onMouseDown={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

export function KeycapGroup({ accelerator }: { accelerator: string }) {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  return (
    <span className="keycap-group">
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          {index > 0 ? <span className="keycap-sep">+</span> : null}
          <span className="keycap">{prettyPart(part)}</span>
        </span>
      ))}
    </span>
  )
}

function prettyPart(part: string): string {
  const map: Record<string, string> = {
    Control: 'Ctrl',
    CommandOrControl: 'Ctrl',
    Command: '⌘',
    Meta: 'Win',
    Super: 'Win',
    Alt: 'Alt',
    Shift: 'Shift',
    Space: '空格',
    Up: '↑',
    Down: '↓',
    Left: '←',
    Right: '→',
    Escape: 'Esc'
  }
  if (map[part]) return map[part]
  if (part.length === 1) return part.toUpperCase()
  return part
}

export function IconLabel({
  icon: Icon,
  children,
  style
}: {
  icon: LucideIcon
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <span className="icon-label" style={style}>
      <Icon size={13} strokeWidth={1.8} />
      {children}
    </span>
  )
}
