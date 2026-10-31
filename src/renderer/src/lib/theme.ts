import { DEFAULT_THEME_COLORS } from '@shared/theme'

type Rgb = { r: number; g: number; b: number }

function parseHex(value: string): Rgb {
  const hex = value.trim().replace(/^#/, '')
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((char) => char + char)
          .join('')
      : hex.padEnd(6, '0').slice(0, 6)
  return {
    r: Number.parseInt(full.slice(0, 2), 16) || 0,
    g: Number.parseInt(full.slice(2, 4), 16) || 0,
    b: Number.parseInt(full.slice(4, 6), 16) || 0
  }
}

function toHex({ r, g, b }: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

function mix(a: string, b: string, amount: number): string {
  const first = parseHex(a)
  const second = parseHex(b)
  return toHex({
    r: first.r + (second.r - first.r) * amount,
    g: first.g + (second.g - first.g) * amount,
    b: first.b + (second.b - first.b) * amount
  })
}

function rgba(value: string, alpha: number): string {
  const { r, g, b } = parseHex(value)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function luminance(value: string): number {
  const { r, g, b } = parseHex(value)
  const channel = (entry: number): number => {
    const normalized = entry / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return channel(r) * 0.2126 + channel(g) * 0.7152 + channel(b) * 0.0722
}

function readableInk(accent: string): string {
  return luminance(accent) > 0.2 ? '#0B0D0B' : '#FFFFFF'
}

export function themeVariables(
  background: string,
  accent: string,
  glass: boolean
): Record<string, string> {
  const darkSurface = luminance(background) < 0.42
  const alpha = glass ? (darkSurface ? 0.84 : 0.86) : darkSurface ? 0.975 : 0.98
  const lighten = (amount: number): string => mix(background, '#FFFFFF', amount)
  const ink = darkSurface ? '#F5F3EA' : '#161A15'
  const inkSoft = darkSurface ? '#E8E6DA' : '#2F352E'
  const inkMuted = darkSurface ? '#A7AEA2' : '#5E665B'
  const inkFaint = darkSurface ? '#7C8479' : '#828A7F'
  const line = darkSurface ? 'rgba(242, 240, 230, 0.095)' : 'rgba(23, 27, 22, 0.11)'
  const lineStrong = darkSurface ? 'rgba(242, 240, 230, 0.19)' : 'rgba(23, 27, 22, 0.2)'
  const lineFaint = darkSurface ? 'rgba(242, 240, 230, 0.05)' : 'rgba(23, 27, 22, 0.055)'
  const accentInk = readableInk(accent)
  return {
    '--bg-shell': rgba(background, alpha),
    '--bg-shell-elevated': darkSurface ? lighten(0.06) : lighten(0.3),
    '--bg-elevated': darkSurface ? lighten(0.11) : lighten(0.62),
    '--bg-inset': darkSurface ? 'rgba(0, 0, 0, 0.32)' : 'rgba(0, 0, 0, 0.055)',
    '--bg-card': darkSurface ? 'rgba(244, 241, 232, 0.036)' : 'rgba(23, 27, 22, 0.038)',
    '--bg-card-hover': darkSurface ? 'rgba(244, 241, 232, 0.062)' : 'rgba(23, 27, 22, 0.07)',
    '--bg-overlay': rgba(background, darkSurface ? 0.76 : 0.82),
    '--ink': ink,
    '--ink-soft': inkSoft,
    '--ink-muted': inkMuted,
    '--ink-faint': inkFaint,
    '--line': line,
    '--line-strong': lineStrong,
    '--line-faint': lineFaint,
    '--accent': accent,
    '--accent-strong': mix(accent, accentInk, 0.08),
    '--accent-soft': rgba(accent, darkSurface ? 0.12 : 0.17),
    '--accent-line': rgba(accent, darkSurface ? 0.34 : 0.32),
    '--accent-ink': accentInk,
    '--selection-ink': accentInk,
    '--scroll-thumb': darkSurface
      ? 'rgba(242, 240, 230, 0.16)'
      : 'rgba(23, 27, 22, 0.18)'
  }
}

export function applyThemeVariables(
  root: HTMLElement,
  colors: { background: string; accent: string; glass: boolean }
): void {
  const variables = themeVariables(colors.background, colors.accent, colors.glass)
  for (const [key, value] of Object.entries(variables)) {
    root.style.setProperty(key, value)
  }
}

export function resolveThemeColors(
  theme: 'dark' | 'light',
  settings: {
    darkBackground: string
    darkAccent: string
    lightBackground: string
    lightAccent: string
  } | null
): { background: string; accent: string } {
  if (theme === 'dark') {
    return {
      background: settings?.darkBackground ?? DEFAULT_THEME_COLORS.darkBackground,
      accent: settings?.darkAccent ?? DEFAULT_THEME_COLORS.darkAccent
    }
  }
  return {
    background: settings?.lightBackground ?? DEFAULT_THEME_COLORS.lightBackground,
    accent: settings?.lightAccent ?? DEFAULT_THEME_COLORS.lightAccent
  }
}
