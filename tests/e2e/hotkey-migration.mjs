import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'flowtray-migrate-'))
const dbPath = join(userData, 'flowtray.db')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.FLOWTRAY_USER_DATA = userData
env.FLOWTRAY_E2E = '1'

const launch = () =>
  electron.launch({
    executablePath: join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.'],
    cwd: root,
    env
  })

let app = await launch()
let page = await app.firstWindow()
await page.waitForTimeout(900)
if (await page.locator('[data-testid="onboarding"]').count()) {
  await page.locator('.onboarding-skip').click()
}
await page.waitForTimeout(300)
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
await new Promise((resolve) => setTimeout(resolve, 800))

const db = new DatabaseSync(dbPath)
db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
  JSON.stringify('Control+Shift+Space'),
  'hotkeyToggle'
)
db.prepare('DELETE FROM meta WHERE key = ?').run('hotkey_default_v2')
db.close()

app = await launch()
page = await app.firstWindow()
await page.waitForTimeout(1000)
const result = await page.evaluate(() => window.flowtray.app.getSnapshot())
console.log('MIGRATED', result.settings.hotkeyToggle, JSON.stringify(result.host.hotkeys.toggle))
if (result.settings.hotkeyToggle !== 'Control+Alt+Shift+Space') {
  throw new Error('legacy hotkey was not migrated')
}
if (!result.host.hotkeys.toggle.ok) throw new Error('migrated hotkey did not register')
console.log('HOTKEY_MIGRATION_OK')
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
