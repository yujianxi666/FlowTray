import { describe, expect, it } from 'vitest'
import { themeVariables } from '@renderer/lib/theme'

describe('theme color variables', () => {
  it('derives a readable dark theme from black + white', () => {
    const vars = themeVariables('#000000', '#FFFFFF', true)
    expect(vars['--bg-shell']).toContain('rgba(0, 0, 0')
    expect(vars['--accent']).toBe('#FFFFFF')
    expect(vars['--accent-ink']).toBe('#0B0D0B')
    expect(vars['--ink']).toBe('#F5F3EA')
    expect(vars['--bg-shell']).toContain('0.84')
  })

  it('derives a readable light theme from white + gray', () => {
    const vars = themeVariables('#FFFFFF', '#808080', true)
    expect(vars['--accent']).toBe('#808080')
    expect(vars['--accent-ink']).toBe('#0B0D0B')
    expect(vars['--ink']).toBe('#161A15')
    expect(vars['--bg-shell']).toContain('0.86')
  })

  it('turns off glass by increasing background opacity', () => {
    const vars = themeVariables('#000000', '#FFFFFF', false)
    expect(vars['--bg-shell']).toContain('0.975')
  })

  it('keeps contrast for a non-standard accent', () => {
    const dark = themeVariables('#101010', '#1F5FFF', true)
    expect(dark['--accent-ink']).toBe('#FFFFFF')
    const light = themeVariables('#FFFFFF', '#FFD400', true)
    expect(light['--accent-ink']).toBe('#0B0D0B')
  })
})
