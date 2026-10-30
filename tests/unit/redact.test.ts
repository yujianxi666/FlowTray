import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { redactString, redactValue } from '@main/lib/redact'

describe('log redaction', () => {
  it('removes absolute paths and filenames', () => {
    const input = `不能读取 C:\\Users\\alice\\Documents\\客户名单.xlsx`
    const output = redactString(input)
    expect(output).toContain('<path>')
    expect(output).not.toContain('客户名单')
    expect(output).not.toContain('alice')
  })

  it('removes the user home even when the drive prefix is missing', () => {
    const output = redactString(`配置文件位于 ${homedir()}\\AppData\\FlowTray`)
    expect(output).not.toContain(homedir())
  })

  it('removes email addresses', () => {
    expect(redactString('联系 alice@example.com 处理')).toBe('联系 <email> 处理')
  })

  it('never keeps clipboard content or URLs in log objects', () => {
    const error = new Error('C:\\Users\\alice\\Desktop\\密码.txt 无法读取')
    const redacted = redactValue({
      error,
      content: 'super-secret-clipboard',
      url: 'https://example.com/private'
    }) as Record<string, unknown>
    const errorValue = redacted.error as Record<string, unknown>
    expect(String(errorValue.message)).not.toContain('密码.txt')
    expect(String(errorValue.message)).toContain('<path>')
    expect(redacted.content).toBe('<redacted>')
    expect(redacted.url).toBe('<redacted>')
  })
})
