import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'flowtray-hotkey-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.FLOWTRAY_USER_DATA = userData
env.FLOWTRAY_E2E = '1'
const shots = join(root, 'screenshots')
mkdirSync(shots, { recursive: true })

const app = await electron.launch({
  executablePath: join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.'],
  cwd: root,
  env
})
const page = await app.firstWindow()
await page.waitForTimeout(1100)
if (await page.locator('[data-testid="onboarding"]').count()) {
  await page.locator('.onboarding-skip').click()
  await page.waitForTimeout(300)
}
await page.evaluate(async () => {
  await window.flowtray.__e2e?.seedItems([
    { type: 'text', text: '快捷键验收：在任意应用中呼出流转台。', name: '快捷键验收', sourceApp: '备忘录' },
    { type: 'url', url: 'https://example.com/flowtray', sourceApp: 'Chrome' }
  ])
  await window.flowtray.__e2e?.flush()
})
await page.waitForTimeout(500)
const host = await page.evaluate(() => window.flowtray.app.getSnapshot().then((value) => value.host))
console.log('HOTKEYS', JSON.stringify(host.hotkeys))
assertTrue(host.hotkeys.toggle.ok, 'global toggle hotkey registered')

const isVisible = () =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((entry) => entry.getTitle().includes('FlowTray'))
    return Boolean(win?.isVisible() && (win?.getBounds().width ?? 0) > 100)
  })

const pressHotkey = () => {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^%+ ')
`
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    windowsHide: true
  })
}

async function waitVisible(expected, timeout = 1200) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if ((await isVisible()) === expected) return Date.now() - started
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return -1
}

assertTrue(await isVisible(), 'shelf starts visible')
pressHotkey()
const hideMs = await waitVisible(false)
console.log('HIDE_MS', hideMs)
assertTrue(hideMs >= 0 && hideMs < 1000, 'hotkey hides within 1s')

pressHotkey()
const showMs = await waitVisible(true)
console.log('SHOW_MS', showMs)
assertTrue(showMs >= 0 && showMs < 1000, 'hotkey shows within 1s')

const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
  const win = BrowserWindow.getAllWindows().find((entry) => entry.getTitle().includes('FlowTray'))
  win?.setAlwaysOnTop(true, 'screen-saver')
  win?.moveTop()
  win?.focus()
  const area = screen.getPrimaryDisplay().workArea
  return { bounds: win?.getBounds(), area }
})
console.log('BOUNDS', JSON.stringify(bounds))
assertTrue(bounds.bounds.x + bounds.bounds.width === bounds.area.x + bounds.area.width, 'docked to right edge')

await page.waitForTimeout(400)
const screenshotScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)
$bmp.Save('${join(shots, 'desktop-docked.png').replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`
execFileSync('powershell.exe', ['-NoProfile', '-Command', screenshotScript], { windowsHide: true })

// Edge reveal: hide, park the pointer at the right edge, and wait for the dwell timer.
await page.evaluate(() => window.flowtray.app.hideWindow())
await new Promise((resolve) => setTimeout(resolve, 400))
assertTrue(!(await isVisible()), 'shelf hidden before edge reveal')
const centerScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(1000, 576)
`
execFileSync('powershell.exe', ['-NoProfile', '-Command', centerScript], { windowsHide: true })
await new Promise((resolve) => setTimeout(resolve, 500))
const edgeScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(2047, 576)
`
execFileSync('powershell.exe', ['-NoProfile', '-Command', edgeScript], { windowsHide: true })
const edgeShowMs = await waitVisible(true, 2500)
console.log('EDGE_SHOW_MS', edgeShowMs)
assertTrue(edgeShowMs >= 0, 'edge dwell reveals the shelf')
await page.waitForTimeout(400)
execFileSync('powershell.exe', ['-NoProfile', '-Command', screenshotScript.replace('desktop-docked.png', 'desktop-edge-reveal.png')], {
  windowsHide: true
})

console.log('HOTKEY_AND_EDGE_CHECKS_PASSED')
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})

function assertTrue(condition, message) {
  if (!condition) {
    console.error('FAILED:', message)
    process.exitCode = 1
    throw new Error(message)
  }
  console.log('✓', message)
}
