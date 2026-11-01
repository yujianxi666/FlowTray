# FlowTray 功能验收（通过 WebView2 CDP 驱动真实界面）
param(
  [string]$Project = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$RunName = "e2e",
  [int]$Port = 9222
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

$script:ws = $null
$script:nextId = 0

function Connect-Cdp {
  $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
  $page = $targets | Where-Object { $_.type -eq "page" } | Select-Object -First 1
  $script:ws = New-Object System.Net.WebSockets.ClientWebSocket
  $script:ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
}

function Invoke-Js([string]$expression) {
  $script:nextId++
  $wrapped = "(async () => { return ($expression); })()"
  $payload = @{
    id = $script:nextId
    method = "Runtime.evaluate"
    params = @{ expression = $wrapped; returnByValue = $true; awaitPromise = $true }
  } | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $segment = New-Object ArraySegment[byte] -ArgumentList @(,$bytes)
  $script:ws.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
  while ($true) {
    $buffer = New-Object byte[] 1048576
    $seg = New-Object ArraySegment[byte] -ArgumentList @(,$buffer)
    $builder = New-Object System.Text.StringBuilder
    do {
      $result = $script:ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).Result
      [void]$builder.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
    } while (-not $result.EndOfMessage)
    $response = $builder.ToString() | ConvertFrom-Json
    if ($response.id -ne $script:nextId) { continue }
    if ($response.result.exceptionDetails) {
      throw ("JS 异常: " + $response.result.exceptionDetails.text + " " + ($response.result.exceptionDetails.exception.description))
    }
    return $response.result.result.value
  }
}

$failures = New-Object System.Collections.ArrayList
function Check([string]$name, [bool]$condition, [string]$detail = "") {
  if ($condition) {
    Write-Output ("  PASS  " + $name)
  } else {
    Write-Output ("  FAIL  " + $name + "  " + $detail)
    [void]$failures.Add($name)
  }
}

Write-Output "== 连接 =="
Connect-Cdp
Check "页面已加载" ([bool](Invoke-Js "typeof window.flowtray === 'object'"))
Check "React 已挂载" ([int](Invoke-Js "document.getElementById('root').children.length") -ge 1)

Write-Output "== 引导与首启 =="
Check "首启显示引导" ([bool](Invoke-Js "!!document.querySelector('[data-testid=onboarding]')"))
Invoke-Js "(document.querySelector('.onboarding-skip').click(), true)" | Out-Null
Start-Sleep -Milliseconds 700
Check "点击跳过后关闭引导" (-not [bool](Invoke-Js "!!document.querySelector('[data-testid=onboarding]')"))
Check "引导完成状态已保存" ([bool](Invoke-Js "(await window.flowtray.app.getSnapshot()).settings.onboardingDone"))

Write-Output "== 文本暂存 =="
$text = "FlowTray E2E 文本 `n第二行内容"
$result = Invoke-Js ("JSON.stringify(await window.flowtray.items.addText({ text: " + ($text | ConvertTo-Json -Compress) + ", source: 'manual' }))")
$parsed = $result | ConvertFrom-Json
Check "文本写入成功" ([bool]$parsed.ok -and [int]$parsed.added -eq 1) $result
$snapshot = Invoke-Js "JSON.stringify(await window.flowtray.app.getSnapshot())" | ConvertFrom-Json
Check "快照含 1 项" ([int]$snapshot.items.Count -eq 1) ("count=" + $snapshot.items.Count)
Check "卡片类型为 text" ($snapshot.items[0].type -eq "text")
$firstId = $snapshot.items[0].id

Write-Output "== 去重 =="
$dup = Invoke-Js ("JSON.stringify(await window.flowtray.items.addText({ text: " + ($text | ConvertTo-Json -Compress) + " }))") | ConvertFrom-Json
Check "重复文本计为 1 项" ([int]$dup.duplicates -eq 1) ($dup | ConvertTo-Json -Compress)

Write-Output "== 文件暂存 =="
$fixtureDir = Join-Path $Project ".tmp\runs\$RunName\fixtures"
New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null
$fixture = Join-Path $fixtureDir "产品需求.txt"
Set-Content -Path $fixture -Value "FlowTray 测试文件" -Encoding UTF8
$fileResult = Invoke-Js ("JSON.stringify(await window.flowtray.items.addPaths([" + ($fixture.Replace('\','\\') | ConvertTo-Json -Compress) + "], { effect: 'copy', source: 'drop' }))") | ConvertFrom-Json
Check "文件写入成功" ([bool]$fileResult.ok -and [int]$fileResult.added -eq 1) ($fileResult | ConvertTo-Json -Compress)
$snapshot = Invoke-Js "JSON.stringify(await window.flowtray.app.getSnapshot())" | ConvertFrom-Json
Check "快照含 2 项" ([int]$snapshot.items.Count -eq 2) ("count=" + $snapshot.items.Count)
$fileItem = $snapshot.items | Where-Object { $_.type -eq "file" } | Select-Object -First 1
Check "文件卡片有真实路径" ([bool]$fileItem.path -and (Test-Path $fileItem.path)) $fileItem.path
Check "文件卡片显示大小" ([int64]$fileItem.size -gt 0)

Write-Output "== 链接暂存 =="
$urlResult = Invoke-Js "JSON.stringify(await window.flowtray.items.addUrls(['https://example.com/a/b'], null))" | ConvertFrom-Json
Check "链接写入成功" ([int]$urlResult.added -eq 1) ($urlResult | ConvertTo-Json -Compress)
$snapshot = Invoke-Js "JSON.stringify(await window.flowtray.app.getSnapshot())" | ConvertFrom-Json
$urlItem = $snapshot.items | Where-Object { $_.type -eq "url" } | Select-Object -First 1
Check "链接卡片名称可读" ($urlItem.name -like "example.com*") $urlItem.name

Write-Output "== 复制到系统剪贴板 =="
$copy = Invoke-Js ("JSON.stringify(await window.flowtray.items.copy(['" + $firstId + "'], 'auto'))") | ConvertFrom-Json
Check "复制文本返回成功" ([bool]$copy.ok) ($copy | ConvertTo-Json -Compress)
Start-Sleep -Milliseconds 400
$clip = Get-Clipboard -Raw
Check "剪贴板内容正确" ($clip -like "FlowTray E2E 文本*") ("clip=" + $clip)

Write-Output "== 固定与取消固定 =="
$pin = Invoke-Js ("JSON.stringify(await window.flowtray.items.pin(['" + $firstId + "'], true))") | ConvertFrom-Json
$snapshot = Invoke-Js "JSON.stringify(await window.flowtray.app.getSnapshot())" | ConvertFrom-Json
$pinned = ($snapshot.items | Where-Object { $_.id -eq $firstId })
Check "固定后 expiresAt 为空" ($null -eq $pinned.expiresAt) ("expiresAt=" + $pinned.expiresAt)
Check "固定计数为 1" ([int]$snapshot.usage.pinnedCount -eq 1)

Write-Output "== 清空与撤销 =="
$clear = Invoke-Js "JSON.stringify(await window.flowtray.items.clear({ includePinned: false }))" | ConvertFrom-Json
$snapshot = Invoke-Js "JSON.stringify(await window.flowtray.app.getSnapshot())" | ConvertFrom-Json
Check "清空后仅剩固定项" ([int]$snapshot.items.Count -eq 1) ("count=" + $snapshot.items.Count)
Check "存在撤销入口" ($null -ne $snapshot.undo) ($snapshot.undo | ConvertTo-Json -Compress)
$undo = Invoke-Js "JSON.stringify(await window.flowtray.items.restoreUndo())" | ConvertFrom-Json
Check "撤销恢复 2 项" ([int]$undo.added -eq 2) ($undo | ConvertTo-Json -Compress)
$snapshot = Invoke-Js "JSON.stringify(await window.flowtray.app.getSnapshot())" | ConvertFrom-Json
Check "撤销后共 3 项" ([int]$snapshot.items.Count -eq 3) ("count=" + $snapshot.items.Count)

Write-Output "== 到期清理 =="
Invoke-Js "window.flowtray.settings.update({ defaultTtl: '1h' })" | Out-Null
$expiring = Invoke-Js ("JSON.stringify(await window.flowtray.items.update('" + $firstId + "', { pinned: false }))") | ConvertFrom-Json
$sweep = Invoke-Js "JSON.stringify(await window.flowtray.app.getSnapshot())" | ConvertFrom-Json
Check "取消固定后有效期恢复" ($null -ne ($sweep.items | Where-Object { $_.id -eq $firstId }).expiresAt)

Write-Output "== 设置持久化 =="
Invoke-Js "window.flowtray.settings.update({ theme: 'dark', shelfSide: 'left', viewMode: 'grid' })" | Out-Null
$settings = Invoke-Js "JSON.stringify((await window.flowtray.app.getSnapshot()).settings)" | ConvertFrom-Json
Check "主题设置为 dark" ($settings.theme -eq "dark")
Check "停靠方向为 left" ($settings.shelfSide -eq "left")
Check "视图为 grid" ($settings.viewMode -eq "grid")
$bad = Invoke-Js "JSON.stringify(await window.flowtray.settings.update({ capacityMb: -5 }))" | ConvertFrom-Json
Check "非法设置被拒绝" (-not [bool]$bad.ok) ($bad | ConvertTo-Json -Compress)
$sameKey = Invoke-Js "JSON.stringify(await window.flowtray.settings.update({ hotkeyCapture: 'Control+Alt+Shift+Space' }))" | ConvertFrom-Json
Check "相同快捷键被拒绝" (-not [bool]$sameKey.ok) ($sameKey | ConvertTo-Json -Compress)

Write-Output "== 删除 =="
Invoke-Js "window.flowtray.settings.update({ shelfSide: 'right', viewMode: 'list' })" | Out-Null
$fileId = ([string]$fileItem.id).Trim()
$remove = Invoke-Js ("JSON.stringify(await window.flowtray.items.remove([" + ($fileId | ConvertTo-Json -Compress) + "]))") | ConvertFrom-Json
Check "删除返回成功" ([bool]$remove.ok) ($remove | ConvertTo-Json -Compress)
$snapshot = Invoke-Js "JSON.stringify(await window.flowtray.app.getSnapshot())" | ConvertFrom-Json
Check "删除后少一项" ([int]$snapshot.items.Count -eq 2) ("count=" + $snapshot.items.Count)

Write-Output "== 界面渲染 =="
Check "界面骨架存在" ([bool](Invoke-Js "!!document.querySelector('[data-testid=shelf]')"))
Check "列表渲染卡片" ([int](Invoke-Js "document.querySelectorAll('[data-item-id]').length") -ge 2)
Check "无控制台错误标记" (([string](Invoke-Js "document.title")).StartsWith("ok:") -or -not ([string](Invoke-Js "document.title")).StartsWith("ERR:"))

Write-Output "== 设置面板 =="
$null = Invoke-Js "window.flowtray.__e2e.openSettings('general')"
Start-Sleep -Milliseconds 1200
Check "设置面板已渲染" ([bool](Invoke-Js "!!document.querySelector('.settings-panel, .sheet-overlay')"))
Check "设置分类导航可用" ([int](Invoke-Js "document.querySelectorAll('.settings-rail button').length") -ge 6)
Check "设置内容区已加载" ([bool](Invoke-Js "!!document.querySelector('[data-testid=settings-content]')"))
Check "React 树仍在" ([int](Invoke-Js "document.getElementById('root').children.length") -ge 1)
Check "设置页无未捕获错误" (-not ([string](Invoke-Js "document.title")).StartsWith("ERR:"))
$null = Invoke-Js "document.querySelector('.settings-topbar button')?.click()"
Start-Sleep -Milliseconds 500
Check "设置面板可关闭" (-not [bool](Invoke-Js "!!document.querySelector('[data-testid=settings-content]')"))

Write-Output ""
if ($failures.Count -eq 0) {
  Write-Output "全部检查通过"
} else {
  Write-Output ("失败 " + $failures.Count + " 项: " + ($failures -join ", "))
  exit 1
}
