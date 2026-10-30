import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'flowtray-capture-'))
const shots = join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
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
const logs = []
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') logs.push(`[${msg.type()}] ${msg.text()}`)
})
page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`))
await page.waitForTimeout(900)

if (await page.locator('[data-testid="onboarding"]').count()) {
  await page.locator('.onboarding-skip').click()
  await page.waitForTimeout(350)
}

await page.evaluate(async (fixtures) => {
  await window.flowtray.__e2e?.setSettings({ onboardingDone: true, theme: 'dark' })
  await window.flowtray.__e2e?.seedItems([
    {
      type: 'text',
      text: '客户反馈汇总\n\n1. 拖拽到微信时希望有明确的复制提示。\n2. 右键菜单里的“固定”很好用，但希望固定后的卡片有更明显的标识。\n3. 过期前 15 分钟提醒很贴心。',
      pinned: true,
      name: '客户反馈 · 三条',
      sourceApp: '备忘录'
    },
    {
      type: 'file',
      path: fixtures.brief,
      sourceApp: '资源管理器',
      name: '产品需求 v2.pdf'
    },
    {
      type: 'image',
      path: fixtures.image,
      sourceApp: 'Chrome',
      name: '界面截图.png'
    },
    {
      type: 'url',
      url: 'https://www.electronjs.org/docs/latest/api/clipboard',
      sourceApp: 'Chrome'
    },
    {
      type: 'folder',
      path: fixtures.folder,
      sourceApp: '资源管理器'
    },
    {
      type: 'file',
      path: fixtures.notes,
      sourceApp: 'Word'
    }
  ])
  await window.flowtray.__e2e?.flush()
}, {
  brief: join(root, 'tests', 'fixtures', '产品需求.pdf'),
  image: join(root, 'tests', 'fixtures', '界面截图.png'),
  folder: join(root, 'tests', 'fixtures', '素材'),
  notes: join(root, 'tests', 'fixtures', '会议纪要.docx')
})

await page.waitForTimeout(700)
console.log('CARDS', await page.locator('[data-testid="item-card"]').count())
console.log('ONBOARDING', await page.locator('[data-testid="onboarding"]').count())
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'shelf-dark-list.png') })

// Settings
await page.locator('[data-testid="open-settings"]').click()
await page.waitForTimeout(350)
await page.locator('[data-testid="settings-panel"]').screenshot({ path: join(shots, 'settings-dark.png') })
await page.getByRole('button', { name: '拖拽', exact: true }).click()
await page.waitForTimeout(200)
await page.locator('[data-testid="settings-panel"]').screenshot({ path: join(shots, 'settings-drag.png') })
await page.locator('.settings-topbar .sheet-back').click()
await page.waitForTimeout(250)

// Selection
const cards = page.locator('[data-testid="item-card"]')
await cards.nth(1).click()
await cards.nth(2).click({ modifiers: ['Control'] })
await cards.nth(3).click({ modifiers: ['Control'] })
await page.waitForTimeout(250)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'shelf-selection-dark.png') })

// Clear dialog
await page.locator('[data-testid="clear-button"]').click()
await page.waitForTimeout(250)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'confirm-clear-dark.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(150)

// Info sheet
await cards.nth(0).click()
await cards.nth(0).click({ button: 'right' })
await page.waitForTimeout(150)
await page.locator('[data-testid="context-menu"]').getByText('查看信息').click()
await page.waitForTimeout(400)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'info-dark.png') })
await page.locator('.sheet-topbar .icon-button').click()
await page.waitForTimeout(200)

// Light theme
await page.evaluate(async () => {
  await window.flowtray.__e2e?.setSettings({ theme: 'light' })
  await window.flowtray.__e2e?.flush()
})
await page.waitForTimeout(400)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'shelf-light-list.png') })

// Grid
await page.evaluate(async () => {
  await window.flowtray.__e2e?.setSettings({ viewMode: 'grid' })
  await window.flowtray.__e2e?.flush()
})
await page.waitForTimeout(400)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'shelf-light-grid.png') })

// Onboarding
await page.evaluate(async () => {
  await window.flowtray.__e2e?.openOnboarding()
})
await page.waitForTimeout(450)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'onboarding-light.png') })
await page.locator('.onboarding-actions .btn-primary').click()
await page.waitForTimeout(300)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'onboarding-step2.png') })
await page.locator('.onboarding-actions .btn-primary').click()
await page.waitForTimeout(300)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'onboarding-step3.png') })

console.log('LOGS', logs.join('\n'))
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
