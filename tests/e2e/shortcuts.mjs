import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'flowtray-hotkeys-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.FLOWTRAY_USER_DATA = userData
env.FLOWTRAY_E2E = '1'

const app = await electron.launch({
  executablePath: join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.'],
  cwd: root,
  env
})
const page = await app.firstWindow()
await page.waitForTimeout(900)
if (await page.locator('[data-testid="onboarding"]').count()) {
  await page.locator('.onboarding-skip').click()
  await page.waitForTimeout(300)
}
await page.evaluate(() => window.flowtray.__e2e?.setSettings({ onboardingDone: true }))
await page.locator('[data-testid="open-settings"]').click()
await page.waitForTimeout(300)
await page.locator('.rail-item').filter({ hasText: '快捷键' }).click()
await page.waitForTimeout(250)

const read = async () =>
  page.evaluate(async () => {
    const snapshot = await window.flowtray.app.getSnapshot()
    return {
      toggle: snapshot.settings.hotkeyToggle,
      capture: snapshot.settings.hotkeyCapture,
      status: snapshot.host.hotkeys
    }
  })

let state = await read()
console.log('INITIAL', JSON.stringify(state))
if (state.toggle !== 'Control+Alt+Shift+Space') throw new Error('default toggle is wrong')
if (!state.status.toggle.ok) throw new Error('default toggle is not registered')

// Record a valid new shortcut.
await page.locator('.hotkey-button').first().click()
await page.waitForTimeout(150)
const listening = await page.locator('.hotkey-row.is-listening').count()
console.log('LISTENING', listening)
await page.keyboard.press('Control+Alt+Shift+K')
await page.waitForTimeout(700)
state = await read()
console.log('AFTER_RECORD', JSON.stringify(state))
if (state.toggle !== 'Control+Alt+Shift+K') throw new Error('recorded shortcut was not saved')
if (!state.status.toggle.ok) throw new Error('recorded shortcut was not registered')

// Modifier-only input must explain the missing main key instead of silently failing.
await page.locator('.hotkey-button').first().click()
await page.waitForTimeout(120)
await page.keyboard.down('Control')
await page.keyboard.down('Alt')
await page.keyboard.down('Shift')
await page.waitForTimeout(250)
const errorText = await page.locator('.hotkey-label em').first().innerText().catch(() => '')
console.log('MODIFIER_ONLY_ERROR', errorText)
if (!errorText.includes('主键')) throw new Error('modifier-only guidance missing')
await page.keyboard.up('Shift')
await page.keyboard.up('Alt')
await page.keyboard.up('Control')
await page.keyboard.press('Escape')
await page.waitForTimeout(250)

// Restore the default through settings and verify registration.
await page.evaluate(() => window.flowtray.__e2e?.setSettings({ hotkeyToggle: 'Control+Alt+Shift+Space' }))
await page.waitForTimeout(500)
state = await read()
console.log('RESTORED', JSON.stringify(state))
if (!state.status.toggle.ok) throw new Error('default shortcut did not re-register')

console.log('SHORTCUT_CHECKS_PASSED')
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
