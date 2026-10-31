import { _electron as electron } from 'playwright-core'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(root, '.tmp-accept-'))
const shots = join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.FLOWTRAY_USER_DATA = userData
env.FLOWTRAY_E2E = '1'

const launch = () =>
  electron.launch({
    executablePath: join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.', ...(process.env.FLOWTRAY_NOSANDBOX === '1' ? ['--no-sandbox'] : [])],
    cwd: root,
    env
  })

const log = (message) => console.log(`✓ ${message}`)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let app = await launch()
let page = await app.firstWindow()
page.on('pageerror', (error) => console.error('[pageerror]', error.message))
await page.waitForTimeout(900)

// --- onboarding -----------------------------------------------------------
assert.equal(await page.locator('[data-testid="onboarding"]').count(), 1, 'onboarding should show on first run')
assert.equal(await page.locator('.onboarding-title').innerText(), '一个快捷键，随叫随到')
await page.locator('.onboarding-actions .btn-primary').click()
await page.locator('.onboarding-actions .btn-primary').click()
assert.ok((await page.locator('.onboarding-title').innerText()).includes('拖出去'))
await page.locator('.onboarding-actions .btn-primary').click()
await page.waitForTimeout(400)
assert.equal(await page.locator('[data-testid="onboarding"]').count(), 0, 'onboarding should close')
log('3-step onboarding completes')

// --- helpers --------------------------------------------------------------
async function snapshot() {
  return page.evaluate(() => window.flowtray.app.getSnapshot())
}
async function cardCount() {
  return page.locator('[data-testid="item-card"]').count()
}
async function seed(specs) {
  await page.evaluate((items) => window.flowtray.__e2e?.seedItems(items), specs)
  await page.evaluate(() => window.flowtray.__e2e?.flush())
  await page.waitForTimeout(150)
}

const fixture = {
  brief: join(root, 'tests', 'fixtures', '产品需求.pdf'),
  image: join(root, 'tests', 'fixtures', '界面截图.png'),
  folder: join(root, 'tests', 'fixtures', '素材'),
  notes: join(root, 'tests', 'fixtures', '会议纪要.docx')
}

await seed([
  { type: 'text', text: '第一条：拖拽验收文本，包含关键词 青柠。', name: '拖拽验收文本', sourceApp: '备忘录' },
  { type: 'url', url: 'https://www.electronjs.org/docs/latest/api/clipboard', sourceApp: 'Chrome' },
  { type: 'file', path: fixture.brief, sourceApp: '资源管理器', name: '产品需求 v2.pdf' },
  { type: 'image', path: fixture.image, sourceApp: 'Chrome', name: '界面截图.png' },
  { type: 'folder', path: fixture.folder, sourceApp: '资源管理器' },
  { type: 'file', path: fixture.notes, sourceApp: 'Word' }
])
assert.equal(await cardCount(), 6, 'six cards should render')
log('six mixed items render')

// --- search & filter ------------------------------------------------------
await page.locator('[data-testid="search-input"]').fill('青柠')
await page.waitForTimeout(200)
assert.equal(await cardCount(), 1, 'search should narrow to one card')
await page.locator('[data-testid="search-input"]').fill('')
await page.waitForTimeout(150)
await page.locator('[data-testid="filter-file"]').click()
await page.waitForTimeout(200)
assert.equal(await cardCount(), 3, 'file filter includes files and folder')
await page.locator('[data-testid="filter-all"]').click()
log('search and type filters work')

// --- clipboard in ---------------------------------------------------------
await app.evaluate(async ({ clipboard }) => {
  await clipboard.writeText('剪贴板验收文本·FlowTray')
})
await page.locator('[data-testid="add-clipboard"]').click()
await page.waitForTimeout(500)
assert.equal(await cardCount(), 7, 'clipboard text should be added')
assert.ok((await page.locator('[data-testid="shelf"]').innerText()).includes('剪贴板验收文本'))
log('clipboard capture adds a text card')

// --- copy text ------------------------------------------------------------
const textId = (await snapshot()).items.find(
  (item) => item.textContent?.includes('青柠') || item.name.includes('拖拽验收')
)?.id
assert.ok(textId, 'text item id exists')
const textCopy = await page.evaluate(
  (id) => window.flowtray.items.copy([id], 'auto'),
  textId
)
assert.ok(textCopy.ok, `text copy should succeed: ${textCopy.message}`)
const clipboardText = await app.evaluate(async ({ clipboard }) => await clipboard.readText())
assert.ok(clipboardText.includes('青柠'), 'clipboard should contain copied text')
log('copy text writes the system clipboard')

// --- copy file ------------------------------------------------------------
const fileId = (await snapshot()).items.find(
  (item) => item.path?.includes('产品需求') || item.name.includes('产品需求')
)?.id
assert.ok(fileId, 'file item id exists')
const fileCopy = await page.evaluate(
  (id) => window.flowtray.items.copy([id], 'auto'),
  fileId
)
assert.ok(fileCopy.ok)
const fileClipboard = await app.evaluate(async ({ clipboard }) => {
  const types = []
  const items = await clipboard.read()
  for (const item of items) types.push(...item.types)
  return { types, text: await clipboard.readText() }
})
assert.ok(fileClipboard.types.includes('text/uri-list'), 'file copy writes uri-list')
assert.ok(fileClipboard.text.includes('产品需求'), 'file copy includes path text')
log('copy file writes a FileDrop-compatible clipboard payload')

// --- drag text in ---------------------------------------------------------
const beforeDrop = await cardCount()
await page.evaluate(() => {
  const target = document.querySelector('[data-testid="shelf"]')
  const transfer = new DataTransfer()
  transfer.setData('text/plain', '外部拖拽文本·来自浏览器')
  for (const type of ['dragenter', 'dragover', 'drop']) {
    target.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      })
    )
  }
})
await page.waitForTimeout(900)
assert.equal(await cardCount(), beforeDrop + 1, 'text drop should add a card')
log('external text drag/drop adds a card')

// --- pin & update ---------------------------------------------------------
const pinResult = await page.evaluate(
  (id) => window.flowtray.items.update(id, { pinned: true }),
  textId
)
assert.ok(pinResult.ok)
await page.waitForTimeout(250)
const pinnedSnapshot = await snapshot()
assert.equal(pinnedSnapshot.items.find((item) => item.id === textId)?.pinned, true)
assert.ok(
  pinnedSnapshot.items.filter((item) => item.pinned).length >= 1,
  'pinned state persists'
)
log('pin state updates')

// --- clear + undo ---------------------------------------------------------
const clearBefore = await cardCount()
await page.locator('[data-testid="clear-button"]').click()
await page.waitForTimeout(250)
await page.locator('.modal-card .btn-danger').click()
await page.waitForTimeout(500)
const clearedCount = await cardCount()
assert.ok(clearedCount < clearBefore, 'clear removes unpinned cards')
assert.equal(await page.locator('[data-testid="undo-toast"]').count(), 1, 'undo toast appears')
await page.locator('[data-testid="undo-toast"] .toast-action').click()
await page.waitForTimeout(500)
assert.equal(await cardCount(), clearBefore, 'undo restores every cleared card')
log(`clear (${clearBefore}→${clearedCount}) and undo restore cards`)

// --- expiry ---------------------------------------------------------------
const beforeExpiry = await cardCount()
await seed([
  {
    type: 'text',
    text: '这是一条已过期内容',
    name: '已过期',
    expiresAt: Date.now() - 60_000
  }
])
assert.equal(await cardCount(), beforeExpiry + 1)
await page.evaluate(() => window.flowtray.__e2e?.sweep())
await page.waitForTimeout(450)
assert.equal(await cardCount(), beforeExpiry, 'expired card is cleaned')
assert.equal(await page.locator('[data-testid="undo-toast"]').count(), 1, 'expiry undo toast appears')
await page.locator('[data-testid="undo-toast"] .toast-action').click()
await page.waitForTimeout(450)
assert.equal(await cardCount(), beforeExpiry + 1, 'expiry undo restores card')
log('expiry sweep and undo work')

// --- window visibility ----------------------------------------------------
await page.evaluate(() => window.flowtray.app.hideWindow())
await page.waitForTimeout(400)
let visible = await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((entry) => entry.getTitle().includes('FlowTray'))
  return Boolean(win?.isVisible() && (win?.getBounds().width ?? 0) > 100)
})
assert.equal(visible, false, 'window hides (peek handle may remain)')
await page.evaluate(() => window.flowtray.app.toggleWindow())
await page.waitForTimeout(500)
visible = await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((entry) => entry.getTitle().includes('FlowTray'))
  return Boolean(win?.isVisible() && (win?.getBounds().width ?? 0) > 100)
})
assert.equal(visible, true, 'window shows again')
log('window hide/show toggle works')

// --- settings -------------------------------------------------------------
await page.locator('[data-testid="open-settings"]').click()
await page.waitForTimeout(350)
assert.equal(await page.locator('[data-testid="settings-panel"]').count(), 1)
for (const label of ['通用', '悬浮窗', '存储与清理', '拖拽', '剪贴板与隐私', '快捷键', '关于']) {
  assert.ok((await page.locator('.settings-rail').innerText()).includes(label), `section ${label}`)
}
await page.getByRole('button', { name: '拖拽', exact: true }).click()
await page.waitForTimeout(200)
await page.locator('[data-testid="settings-panel"]').screenshot({ path: join(shots, 'settings-drag-final.png') })
await page.getByRole('button', { name: '剪贴板与隐私', exact: true }).click()
await page.waitForTimeout(200)
await page.locator('[data-testid="settings-panel"]').screenshot({ path: join(shots, 'settings-privacy-final.png') })
await page.getByRole('button', { name: '快捷键', exact: true }).click()
await page.waitForTimeout(200)
await page.locator('[data-testid="settings-panel"]').screenshot({ path: join(shots, 'settings-shortcuts-final.png') })
await page.getByRole('button', { name: '通用', exact: true }).click()
await page.waitForTimeout(200)
await page.getByRole('radio', { name: '浅色' }).click()
await page.waitForTimeout(300)
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
await page.locator('.settings-topbar .sheet-back').click()
await page.waitForTimeout(250)
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'shelf-light-final.png') })
log('settings sections render and theme switches live')

// --- persistence ----------------------------------------------------------
const beforeRestart = await cardCount()
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
await wait(900)
app = await launch()
page = await app.firstWindow()
await page.waitForTimeout(1100)
assert.equal(await page.locator('[data-testid="onboarding"]').count(), 0, 'onboarding does not repeat')
assert.equal(await cardCount(), beforeRestart, 'cards persist across restart')
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
log('items and settings persist across restart')

// --- 50 cards -------------------------------------------------------------
const fifty = Array.from({ length: 50 }, (_, index) => ({
  type: 'text',
  text: `性能测试条目 ${index + 1}：${'拖拽、暂存、清理。'.repeat(3)}`,
  name: `性能 ${index + 1}`,
  sourceApp: 'E2E'
}))
const startedAt = Date.now()
await page.evaluate((items) => window.flowtray.__e2e?.seedItems(items), fifty)
await page.evaluate(() => window.flowtray.__e2e?.flush())
const seedElapsed = Date.now() - startedAt
await page.waitForFunction(() => document.querySelectorAll('[data-testid="item-card"]').length >= 56)
const renderElapsed = Date.now() - startedAt
const scrollStarted = Date.now()
await page.locator('[data-testid="item-scroll"]').evaluate((element) => {
  element.scrollTop = element.scrollHeight
})
await page.waitForTimeout(80)
const scrollElapsed = Date.now() - scrollStarted
assert.ok((await cardCount()) >= 56, '50 extra cards render')
log(`50-card load ${seedElapsed}ms, total ${renderElapsed}ms, scroll ${scrollElapsed}ms`)
await page.setViewportSize({ width: 412, height: 696 }).catch(() => {})
await page.locator('[data-testid="shelf"]').screenshot({ path: join(shots, 'shelf-50-final.png') })

console.log('USER_DATA=' + userData)
console.log('ALL_ACCEPTANCE_CHECKS_PASSED')
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
