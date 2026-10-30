import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'flowtray-shots-'))
const out = join(root, 'docs', 'screenshots')
const fixtures = {
  brief: join(root, 'tests', 'fixtures', '产品需求.pdf'),
  image: join(root, 'tests', 'fixtures', '界面截图.png'),
  folder: join(root, 'tests', 'fixtures', '素材'),
  notes: join(root, 'tests', 'fixtures', '会议纪要.docx')
}
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
await page.waitForTimeout(1000)

const shelf = page.locator('[data-testid="shelf"]')
const shot = async (name, locator = shelf) => {
  await locator.screenshot({ path: join(out, name) })
  console.log('shot', name)
}

// Dark onboarding
await page.evaluate(() => window.flowtray.__e2e?.setSettings({ theme: 'dark' }))
await page.waitForTimeout(350)
await shot('onboarding-dark-1.png')
await page.locator('.onboarding-actions .btn-primary').click()
await page.waitForTimeout(250)
await shot('onboarding-dark-2.png')
await page.locator('.onboarding-actions .btn-primary').click()
await page.waitForTimeout(250)
await shot('onboarding-dark-3.png')
await page.locator('.onboarding-actions .btn-primary').click()
await page.waitForTimeout(4700)
await shot('empty-dark.png')
await page.evaluate(() => window.flowtray.__e2e?.setSettings({ theme: 'light' }))
await page.waitForTimeout(300)
await shot('empty-light.png')
await page.evaluate(() => window.flowtray.__e2e?.setSettings({ theme: 'dark' }))
await page.waitForTimeout(300)

await page.evaluate(() =>
  window.flowtray.__e2e?.setSettings({
    onboardingDone: true,
    theme: 'dark',
    storageMode: 'copy',
    viewMode: 'list',
    showSourceApp: true
  })
)
await page.evaluate(async (paths) => {
  await window.flowtray.__e2e?.seedItems([
    {
      type: 'text',
      text: '客户反馈汇总\n1. 拖拽到微信时希望有明确的复制提示。\n2. 右键菜单里的“固定”很好用，但希望固定后的卡片有更明显的标识。\n3. 过期前 15 分钟提醒很贴心。',
      name: '客户反馈 · 三条',
      sourceApp: '备忘录',
      pinned: true
    },
    {
      type: 'url',
      url: 'https://www.electronjs.org/docs/latest/api/clipboard',
      sourceApp: 'Chrome'
    },
    {
      type: 'file',
      path: paths.brief,
      name: '产品需求 v2.pdf',
      sourceApp: '资源管理器'
    },
    {
      type: 'image',
      path: paths.image,
      name: '界面截图.png',
      sourceApp: 'Chrome'
    },
    {
      type: 'folder',
      path: paths.folder,
      sourceApp: '资源管理器'
    },
    {
      type: 'file',
      path: paths.notes,
      sourceApp: 'Word'
    }
  ])
  await window.flowtray.__e2e?.flush()
}, fixtures)
await page.waitForTimeout(800)
await shot('shelf-dark.png')

// Selection
const cards = page.locator('[data-testid="item-card"]')
await cards.nth(1).click()
await cards.nth(2).click({ modifiers: ['Control'] })
await page.waitForTimeout(300)
await shot('selection-dark.png')

// Info sheet for the pinned note
await cards.nth(0).click({ button: 'right' })
await page.waitForTimeout(250)
await page.locator('[data-testid="context-menu"]').getByText('查看信息', { exact: true }).click()
await page.waitForTimeout(350)
await shot('info-dark.png')
await page.locator('.sheet-topbar .sheet-back').click()
await page.waitForTimeout(250)
await page.locator('.selection-actions .selection-action').last().click()
await page.waitForTimeout(250)

// Settings dark
await page.locator('[data-testid="open-settings"]').click()
await page.waitForTimeout(350)
await shot('settings-dark.png')
await page.getByRole('button', { name: '存储与清理', exact: true }).click()
await page.waitForTimeout(250)
await shot('settings-storage-dark.png')
await page.getByRole('button', { name: '剪贴板与隐私', exact: true }).click()
await page.waitForTimeout(250)
await shot('settings-privacy-dark.png')
await page.locator('.settings-topbar .sheet-back').click()
await page.waitForTimeout(300)

// Light list and grid
await page.locator('[data-testid="open-settings"]').click()
await page.waitForTimeout(250)
await page.getByRole('button', { name: '通用', exact: true }).click()
await page.waitForTimeout(200)
await page.getByRole('radio', { name: '浅色' }).click()
await page.waitForTimeout(300)
await page.locator('.settings-topbar .sheet-back').click()
await page.waitForTimeout(350)
await shot('shelf-light.png')
await page.locator('[data-testid="view-grid"]').click()
await page.waitForTimeout(300)
await shot('shelf-light-grid.png')

// Onboarding light
await page.evaluate(() => window.flowtray.__e2e?.openOnboarding())
await page.waitForTimeout(400)
await shot('onboarding-light.png')
await page.locator('.onboarding-skip').click()
await page.waitForTimeout(250)

// Desktop edge shot, dark list
await page.evaluate(() =>
  window.flowtray.__e2e?.setSettings({ theme: 'dark', viewMode: 'list', onboardingDone: true })
)
await page.waitForTimeout(350)
const info = await app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.moveTop()
  win.focus()
  const display = screen.getPrimaryDisplay()
  const width = Math.round(display.size.width * display.scaleFactor)
  const height = Math.round(display.size.height * display.scaleFactor)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  const png = sources[0]?.thumbnail.toPNG()
  return { base64: png ? png.toString('base64') : '' }
})
if (info.base64) {
  const full = Buffer.from(info.base64, 'base64')
  writeFileSync(join(out, 'desktop-edge.png'), full)
  console.log('shot desktop-edge.png', full.length)
}
console.log('DONE')
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
