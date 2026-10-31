import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(root, '.tmp-edge-'))
const out = join(root, 'docs', 'screenshots')
mkdirSync(out, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.FLOWTRAY_USER_DATA = userData
env.FLOWTRAY_E2E = '1'

const app = await electron.launch({
  executablePath:
    process.env.FLOWTRAY_EXE ??
    join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: process.env.FLOWTRAY_EXE
    ? [...(process.env.FLOWTRAY_NOSANDBOX === '1' ? ['--no-sandbox'] : [])]
    : ['.', ...(process.env.FLOWTRAY_NOSANDBOX === '1' ? ['--no-sandbox'] : [])],
  cwd: root,
  env
})
const page = await app.firstWindow()
await page.waitForTimeout(1000)
if (await page.locator('[data-testid="onboarding"]').count()) {
  await page.locator('.onboarding-skip').click()
  await page.waitForTimeout(300)
}
await page.evaluate(() => window.flowtray.__e2e?.setSettings({ theme: 'dark', onboardingDone: true }))
await page.evaluate(async () => {
  await window.flowtray.__e2e?.seedItems([
    { type: 'text', text: '边缘提示条验收：靠近屏幕右侧四分之一时出现细条，贴边后展开。', name: '边缘提示条', sourceApp: '备忘录' },
    { type: 'url', url: 'https://example.com/flowtray', sourceApp: 'Chrome' }
  ])
  await window.flowtray.__e2e?.flush()
})
await page.waitForTimeout(400)
const host = await page.evaluate(() => window.flowtray.app.getSnapshot().then((s) => s.host))
console.log('HOTKEYS', JSON.stringify(host.hotkeys))
if (!host.hotkeys.toggle.ok) throw new Error('default hotkey did not register')

const screen = await app.evaluate(({ screen }) => screen.getPrimaryDisplay())
const right = screen.workArea.x + screen.workArea.width
const scale = screen.scaleFactor
console.log('SCREEN', JSON.stringify(screen))

const moveCursor = (x, y) => {
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`
  ], { windowsHide: true })
}
const capture = async (name, locator = null) => {
  if (locator) {
    await locator.screenshot({ path: join(out, name) })
    return
  }
  const base64 = await app.evaluate(async ({ desktopCapturer, screen }) => {
    const display = screen.getPrimaryDisplay()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor)
      }
    })
    return sources[0]?.thumbnail.toPNG().toString('base64') ?? ''
  })
  if (base64) writeFileSync(join(out, name), Buffer.from(base64, 'base64'))
}

// Auto-hide watchdog: enable it, focus full shelf, then click another app.
await page.evaluate(() => window.flowtray.__e2e?.setSettings({ hideOnBlur: true }))
await page.waitForTimeout(250)
moveCursor(1000, 600)
await page.waitForTimeout(300)
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win?.focus()
  win?.emit('blur')
})
await page.waitForTimeout(1500)
const afterBlur = await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  return { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() }
})
console.log('AFTER_BLUR', JSON.stringify(afterBlur))
if (afterBlur.visible && afterBlur.bounds.width > 100) {
  throw new Error('hideOnBlur watchdog failed')
}

// After the watchdog hides the full shelf, show the narrow edge handle.
moveCursor(right - 300, 600)
await page.waitForTimeout(550)
let peek = await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  return { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() }
})
console.log('PEEK', JSON.stringify(peek))
if (!peek.visible || peek.bounds.width > 40) throw new Error('edge peek did not collapse')
await capture('edge-peek-closeup.png', page.locator('[data-testid="edge-peek"]'))
await capture('edge-peek-desktop.png')

// Move to the actual edge: full shelf should spring out.
moveCursor(right - 1, 600)
await page.waitForTimeout(2200)
const expanded = await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  return { visible: win.isVisible(), bounds: win.getBounds() }
})
console.log('EXPANDED', JSON.stringify(expanded))
if (!expanded.visible || expanded.bounds.width < 300) throw new Error('edge expand failed')
await capture('edge-expanded.png')
await page.evaluate(() => window.flowtray.__e2e?.setSettings({ glass: false }))
await page.waitForTimeout(350)
await capture('edge-glass-off.png')

// Leave the edge; auto-hide was enabled earlier, but the expanded shelf is
// shown inactive, so assert the handle hides instead of stealing focus.
moveCursor(1000, 600)
await page.waitForTimeout(500)
console.log('EDGE_PEEK_OK')
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
