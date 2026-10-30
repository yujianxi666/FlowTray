import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ForegroundInfo {
  processName: string
  title: string
  appName: string
}

const FRIENDLY_NAMES: Record<string, string> = {
  explorer: '资源管理器',
  chrome: 'Chrome',
  msedge: 'Edge',
  firefox: 'Firefox',
  wechat: '微信',
  weixin: '微信',
  qq: 'QQ',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  feishu: '飞书',
  lark: '飞书',
  dingtalk: '钉钉',
  code: 'VS Code',
  notepad: '记事本',
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  outlook: 'Outlook',
  thunderbird: 'Thunderbird',
  wps: 'WPS',
  acrord32: 'Acrobat Reader',
  photoshop: 'Photoshop',
  figma: 'Figma',
  notion: 'Notion',
  obsidian: 'Obsidian',
  spotify: 'Spotify',
  vlc: 'VLC',
  electron: 'FlowTray'
}

const POWERSHELL =
  process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'

const SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FlowTrayForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$handle = [FlowTrayForeground]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 512
[void][FlowTrayForeground]::GetWindowText($handle, $builder, 512)
$processId = [uint32]0
[void][FlowTrayForeground]::GetWindowThreadProcessId($handle, [ref]$processId)
$process = Get-Process -Id $processId
if ($process) {
  $title = $builder.ToString() -replace "[\\r\\n\\t]", " "
  [Console]::Out.WriteLine($process.ProcessName + [char]9 + $title)
}
`

export function friendlyAppName(processName: string): string {
  const key = processName.toLowerCase().replace(/\.exe$/i, '')
  return FRIENDLY_NAMES[key] || processName.replace(/\.exe$/i, '')
}

class ForegroundService {
  private cache: ForegroundInfo | null = null
  private cachedAt = 0
  private pending: Promise<ForegroundInfo | null> | null = null

  async get(options: { bypassCache?: boolean } = {}): Promise<ForegroundInfo | null> {
    const now = Date.now()
    if (!options.bypassCache && this.cache && now - this.cachedAt < 400) {
      return this.cache
    }
    if (this.pending) return this.pending
    this.pending = this.query()
    try {
      const result = await this.pending
      if (result) {
        this.cache = result
        this.cachedAt = Date.now()
      }
      return result
    } finally {
      this.pending = null
    }
  }

  private async query(): Promise<ForegroundInfo | null> {
    if (process.platform !== 'win32') return null
    try {
      const { stdout } = await execFileAsync(
        POWERSHELL,
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
        {
          timeout: 1500,
          windowsHide: true,
          maxBuffer: 64 * 1024,
          encoding: 'utf8'
        }
      )
      const line = stdout.trim()
      if (!line) return null
      const [processName, ...titleParts] = line.split('\t')
      if (!processName) return null
      const cleanProcess = processName.trim().slice(0, 120)
      const title = titleParts.join(' ').trim().slice(0, 300)
      return {
        processName: cleanProcess,
        title,
        appName: friendlyAppName(cleanProcess)
      }
    } catch {
      return null
    }
  }
}

export const foreground = new ForegroundService()
