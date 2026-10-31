import { _electron as electron } from 'playwright-core'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const exe = process.env.FLOWTRAY_EXE ?? join(root, 'release', 'win-unpacked', 'FlowTray.exe')
if (!existsSync(exe)) throw new Error(`missing packaged app: ${exe}`)
const userData = mkdtempSync(join(root, '.tmp-packaged-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.FLOWTRAY_USER_DATA = userData
env.FLOWTRAY_E2E = '1'

const app = await electron.launch({
  executablePath: exe,
  args: process.env.FLOWTRAY_NOSANDBOX === '1' ? ['--no-sandbox'] : [],
  cwd: root,
  env
})
const page = await app.firstWindow()
await page.waitForTimeout(1400)
console.log('TITLE', await page.title())
console.log('URL', page.url())
if (await page.locator('[data-testid="onboarding"]').count()) {
  await page.locator('.onboarding-skip').click()
  await page.waitForTimeout(400)
}
await app.evaluate(async ({ clipboard }) => {
  await clipboard.writeText('打包冒烟测试·FlowTray')
})
await page.locator('[data-testid="add-clipboard"]').click()
await page.waitForTimeout(600)
const count = await page.locator('[data-testid="item-card"]').count()
console.log('CARDS', count)
console.log('DB_EXISTS', existsSync(join(userData, 'flowtray.db')))
console.log('STORAGE_EXISTS', existsSync(join(userData, 'storage')))
const versions = await app.evaluate(({ app }) => ({
  version: app.getVersion(),
  packaged: app.isPackaged,
  resources: process.resourcesPath
}))
console.log('APP', JSON.stringify(versions))
const snapshot = await page.evaluate(() => window.flowtray.app.getSnapshot())
console.log('HOTKEY', snapshot.settings.hotkeyToggle, JSON.stringify(snapshot.host.hotkeys.toggle))
if (snapshot.settings.hotkeyToggle !== 'Control+Alt+Shift+Space') {
  throw new Error('packaged app has stale default hotkey')
}
if (!snapshot.host.hotkeys.toggle.ok) throw new Error('packaged hotkey not registered')
if (
  snapshot.settings.darkBackground !== '#000000' ||
  snapshot.settings.darkAccent !== '#FFFFFF' ||
  snapshot.settings.lightBackground !== '#FFFFFF' ||
  snapshot.settings.lightAccent !== '#808080'
) {
  throw new Error('packaged theme defaults are stale')
}
if (count !== 1) throw new Error('packaged app did not add a clipboard card')
if (process.env.FLOWTRAY_SHOT) {
  await page.locator('[data-testid="shelf"]').screenshot({ path: process.env.FLOWTRAY_SHOT })
}
console.log('PACKAGED_SMOKE_OK')
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
