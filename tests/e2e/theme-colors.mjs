import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'flowtray-theme-'))
const out = join(root, 'docs', 'screenshots')
mkdirSync(out, { recursive: true })
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
await page.evaluate(() => window.flowtray.__e2e?.setSettings({ onboardingDone: true, theme: 'dark' }))
await page.waitForTimeout(300)
await page.locator('[data-testid="open-settings"]').click()
await page.waitForTimeout(400)
await page.locator('.settings-content').evaluate((node) => {
  node.scrollTop = node.scrollHeight
})
await page.waitForTimeout(200)
await page.locator('[data-testid="settings-panel"]').screenshot({ path: join(out, 'settings-theme-dark.png') })
console.log('shot settings-theme-dark.png')

// Custom dark palette
await page.evaluate(() =>
  window.flowtray.__e2e?.setSettings({
    darkBackground: '#101820',
    darkAccent: '#FF5C8A'
  })
)
await page.waitForTimeout(350)
await page.locator('.settings-topbar .sheet-back').click()
await page.waitForTimeout(300)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(out, 'theme-custom-dark.png') })
console.log('shot theme-custom-dark.png')

// Custom light palette
await page.evaluate(() =>
  window.flowtray.__e2e?.setSettings({
    theme: 'light',
    lightBackground: '#FFFFFF',
    lightAccent: '#5B6670'
  })
)
await page.waitForTimeout(350)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(out, 'theme-custom-light.png') })
console.log('shot theme-custom-light.png')
const vars = await page.evaluate(() => {
  const style = getComputedStyle(document.documentElement)
  return {
    accent: style.getPropertyValue('--accent').trim(),
    bg: style.getPropertyValue('--bg-shell').trim(),
    ink: style.getPropertyValue('--ink').trim()
  }
})
console.log('VARS', JSON.stringify(vars))
if (vars.accent !== '#5B6670') throw new Error('accent CSS variable not applied')
if (!vars.bg.includes('255, 255, 255')) throw new Error('background CSS variable not applied')
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
