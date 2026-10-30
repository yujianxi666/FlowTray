import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'flowtray-probe-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.FLOWTRAY_USER_DATA = userData
env.FLOWTRAY_E2E = '1'

const logs = []
const app = await electron.launch({
  executablePath: join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.'],
  cwd: root,
  env
})

app.on('console', (msg) => logs.push(`[main console] ${msg.type()}: ${msg.text()}`))
const page = await app.firstWindow()
page.on('console', (msg) => logs.push(`[renderer ${msg.type()}] ${msg.text()}`))
page.on('pageerror', (error) => logs.push(`[pageerror] ${error.stack || error.message}`))
await page.waitForTimeout(1600)
console.log('TITLE', await page.title())
console.log('URL', page.url())
console.log('BODY', await page.locator('body').innerText().catch((error) => `ERR ${error.message}`))
console.log('HTML', (await page.locator('#root').innerHTML().catch(() => 'ERR')).slice(0, 600))
console.log('VISIBLE', await page.locator('.shelf').isVisible().catch(() => false))
console.log('BOUNDS', await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })))
mkdirSync(join(root, 'screenshots'), { recursive: true })
await page.screenshot({ path: join(root, 'screenshots', 'page-01.png'), omitBackground: false })
console.log('LOGS', logs.join('\n'))
await app.close()
writeFileSync(join(root, 'screenshots', 'probe-user-data.txt'), userData)
