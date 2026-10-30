import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const userData = mkdtempSync(join(tmpdir(), 'flowtray-dragout-'))
const target = join(root, 'tests', 'drop-target')
const fixtureFile = join(root, 'tests', 'fixtures', '产品需求.pdf')
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
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
await page.evaluate(async (filePath) => {
  await window.flowtray.__e2e?.seedItems([
    {
      type: 'file',
      path: filePath,
      sourceApp: '资源管理器',
      name: '拖出测试.pdf'
    }
  ])
  await window.flowtray.__e2e?.flush()
}, fixtureFile)
await page.waitForTimeout(500)
const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.moveTop()
  win.focus()
  const display = screen.getPrimaryDisplay()
  return { bounds: win.getBounds(), scale: display.scaleFactor }
})
const card = await page.locator('[data-testid="item-card"]').first().boundingBox()
if (!card) throw new Error('no card')
const source = {
  x: Math.round(bounds.bounds.x + card.x + 120),
  y: Math.round(bounds.bounds.y + card.y + card.height / 2)
}
console.log('BOUNDS', JSON.stringify(bounds), 'CARD', JSON.stringify(card), 'SOURCE', JSON.stringify(source))

const explorer = execFileSync('powershell.exe', ['-NoProfile', '-Command', `
$target = '${target.replace(/'/g, "''")}'
Start-Process explorer.exe -ArgumentList $target | Out-Null
Start-Sleep -Milliseconds 1600
$proc = Get-Process explorer | Where-Object { $_.MainWindowTitle -like '*drop-target*' } | Select-Object -First 1
if (-not $proc) { Write-Output 'NO_WINDOW'; exit 2 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DragWin {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
"@
$handle = $proc.MainWindowHandle
[DragWin]::ShowWindow($handle, 9) | Out-Null
[DragWin]::SetWindowPos($handle, [IntPtr](-1), 80, 180, 900, 720, 0x0040) | Out-Null
[DragWin]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 700
Write-Output "HANDLE=$handle"
`], { encoding: 'utf8', windowsHide: true })
console.log('EXPLORER', explorer.trim())

const info = await app.evaluate(async ({ desktopCapturer, screen, BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
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
if (info.base64) writeFileSync(join(root, 'screenshots', 'dragout-before.png'), Buffer.from(info.base64, 'base64'))

execFileSync('powershell.exe', ['-NoProfile', '-Command', `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DragRun {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
"@
$proc = Get-Process explorer | Where-Object { $_.MainWindowTitle -like '*drop-target*' } | Select-Object -First 1
if ($proc) {
  [DragRun]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
  [DragRun]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
}
Start-Sleep -Milliseconds 400
$sx = ${source.x}; $sy = ${source.y}
$tx = 500; $ty = 480
[DragRun]::SetCursorPos($sx, $sy) | Out-Null
Start-Sleep -Milliseconds 250
[DragRun]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
[DragRun]::SetCursorPos($sx + 24, $sy + 12) | Out-Null
Start-Sleep -Milliseconds 450
for ($i = 1; $i -le 24; $i++) {
  $x = [int]($sx + (($tx - $sx) * $i / 24)); $y = [int]($sy + (($ty - $sy) * $i / 24))
  [DragRun]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 45
}
Start-Sleep -Milliseconds 500
[DragRun]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 1200
$proc = Get-Process explorer | Where-Object { $_.MainWindowTitle -like '*drop-target*' } | Select-Object -First 1
if ($proc) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DragRestore { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags); }
"@
  [DragRestore]::SetWindowPos($proc.MainWindowHandle, [IntPtr](-2), 80, 180, 900, 720, 0) | Out-Null
}
`], { encoding: 'utf8', windowsHide: true })

await page.waitForTimeout(1000)
const files = existsSync(target) ? readdirSync(target) : []
console.log('TARGET_FILES', JSON.stringify(files))
const snapshot = await page.evaluate(() => window.flowtray.app.getSnapshot())
console.log('APP_ITEMS', snapshot.items.length, JSON.stringify(snapshot.items.map((item) => ({ name: item.name, status: item.status }))))
console.log('SOURCE_STILL_EXISTS', existsSync(fixtureFile))
if (files.length === 0) {
  console.error('DRAG_OUT_FAILED')
  process.exitCode = 1
} else {
  console.log('DRAG_OUT_OK')
}
try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p = Get-Process explorer | Where-Object { $_.MainWindowTitle -like '*drop-target*' } | Select-Object -First 1; if ($p) { $null = $p.CloseMainWindow() }`], { windowsHide: true })
} catch {}
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
