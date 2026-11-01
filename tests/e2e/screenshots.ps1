# Seed a realistic shelf through the e2e hooks and capture documentation screenshots.
param(
  [string]$Project = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$OutDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path "docs\screenshots"),
  [int]$Port = 9222
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Connect-Page {
  $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
  $page = $targets | Where-Object { $_.type -eq "page" } | Select-Object -First 1
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
  return $ws
}

function Receive-Text($ws, [int]$size) {
  $buffer = New-Object byte[] $size
  $seg = New-Object ArraySegment[byte] -ArgumentList @(,$buffer)
  $builder = New-Object System.Text.StringBuilder
  do {
    $res = $ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).Result
    [void]$builder.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $res.Count))
  } while (-not $res.EndOfMessage)
  return $builder.ToString()
}

function Invoke-CdpEval([string]$expression) {
  $ws = Connect-Page
  $wrapped = "(async () => { try { return (" + $expression + "); } catch (error) { return 'JSERR: ' + error.message; } })()"
  $payload = @{ id = 1; method = "Runtime.evaluate"; params = @{ expression = $wrapped; returnByValue = $true; awaitPromise = $true } } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object ArraySegment[byte] -ArgumentList @(,$bytes)
  $ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
  $text = Receive-Text $ws 4194304
  $ws.Dispose()
  $parsed = $text | ConvertFrom-Json
  if ($parsed.result.exceptionDetails) {
    return ("JSERR: " + $parsed.result.exceptionDetails.text)
  }
  return $parsed.result.result.value
}

function Save-PageShot([string]$name) {
  $ws = Connect-Page
  $payload = '{"id":2,"method":"Page.captureScreenshot","params":{"format":"png","captureBeyondViewport":false}}'
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object ArraySegment[byte] -ArgumentList @(,$bytes)
  $ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
  $text = Receive-Text $ws 33554432
  $ws.Dispose()
  $parsed = $text | ConvertFrom-Json
  $path = Join-Path $OutDir ($name + ".png")
  [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($parsed.result.data))
  Write-Output ("saved " + $path)
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$base = $Project -replace "\\", "/"
$fixtures = $base + "/legacy-electron/tests/fixtures"

$seed = @(
  "{type:'file', path:'$fixtures/产品需求.pdf', name:'产品需求.pdf', sourceApp:'资源管理器'}",
  "{type:'file', path:'$fixtures/会议纪要.docx', name:'会议纪要.docx', sourceApp:'微信'}",
  "{type:'image', path:'$fixtures/界面截图.png', name:'界面截图.png', sourceApp:'截图工具'}",
  "{type:'file', path:'$base/README.md', name:'README.md', sourceApp:'VS Code'}",
  "{type:'text', text:'周五之前把三份材料发到项目群：产品需求、会议纪要、界面截图。记得附上验收清单。', sourceApp:'记事本'}",
  "{type:'url', url:'https://tauri.app/start/', sourceApp:'浏览器'}"
)
$result = Invoke-CdpEval ("window.flowtray.__e2e.seedItems([" + ($seed -join ",") + "])")
Write-Output ("seed: " + $result)
Start-Sleep -Milliseconds 900

$null = Invoke-CdpEval "window.flowtray.settings.update({ onboardingDone: true, theme: 'dark', viewMode: 'list', shelfSide: 'right' })"
Start-Sleep -Milliseconds 700
$null = Invoke-CdpEval "(document.querySelectorAll('.sheet-overlay').forEach(function (node) { node.remove() }), true)"
Start-Sleep -Milliseconds 500
Save-PageShot "shelf-dark"

$null = Invoke-CdpEval "window.flowtray.settings.update({ viewMode: 'grid' })"
Start-Sleep -Milliseconds 800
Save-PageShot "shelf-dark-grid"

$null = Invoke-CdpEval "window.flowtray.settings.update({ viewMode: 'list', theme: 'light' })"
Start-Sleep -Milliseconds 800
Save-PageShot "shelf-light"

$null = Invoke-CdpEval "window.flowtray.settings.update({ theme: 'dark' })"
Start-Sleep -Milliseconds 600
$null = Invoke-CdpEval "(document.querySelectorAll('.topbar button')[document.querySelectorAll('.topbar button').length - 1].click(), true)"
Start-Sleep -Milliseconds 900
Save-PageShot "settings-general"

$null = Invoke-CdpEval "(document.querySelectorAll('.settings-nav button')[5].click(), true)"
Start-Sleep -Milliseconds 800
Save-PageShot "settings-shortcuts"

$null = Invoke-CdpEval "(document.querySelectorAll('.settings-nav button')[6].click(), true)"
Start-Sleep -Milliseconds 800
Save-PageShot "settings-about"
