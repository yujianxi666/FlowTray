import { Menu, Tray, nativeImage } from 'electron'
import { formatAccelerator } from '@shared/format'
import { appIconPath } from '@main/lib/paths'
import type { Settings } from '@shared/settings'
import type { StorageUsage } from '@shared/types'

export interface TrayActions {
  onToggle: () => void
  onShow: () => void
  onCapture: () => void
  onClear: () => void
  onSettings: () => void
  onOnboarding: () => void
  onQuit: () => void
  onToggleLaunchAtLogin: (enabled: boolean) => void
}

export class TrayManager {
  private tray: Tray | null = null

  constructor(private readonly actions: TrayActions) {}

  create(): void {
    if (this.tray) return
    let icon = nativeImage.createFromPath(appIconPath())
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty()
    } else {
      icon = icon.resize({ width: 32, height: 32 })
    }
    this.tray = new Tray(icon)
    this.tray.setToolTip('FlowTray 流转台')
    this.tray.on('click', () => {
      this.actions.onToggle()
    })
    this.tray.on('double-click', () => {
      this.actions.onShow()
    })
  }

  update(settings: Settings, usage: StorageUsage, visible: boolean): void {
    if (!this.tray) return
    const toggleLabel = visible ? '隐藏流转台' : '显示流转台'
    const menu = Menu.buildFromTemplate([
      {
        label: `${toggleLabel}    ${formatAccelerator(settings.hotkeyToggle)}`,
        click: () => this.actions.onToggle()
      },
      {
        label: `从剪贴板暂存    ${formatAccelerator(settings.hotkeyCapture)}`,
        click: () => this.actions.onCapture()
      },
      { type: 'separator' },
      {
        label: `已暂存 ${usage.itemCount} 项 · 固定 ${usage.pinnedCount} 项`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: '清空未固定项…',
        click: () => this.actions.onClear()
      },
      {
        label: '设置…',
        click: () => this.actions.onSettings()
      },
      {
        label: '查看新手引导',
        click: () => this.actions.onOnboarding()
      },
      { type: 'separator' },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: settings.launchAtLogin || settings.launchAsAdmin,
        click: (item) => this.actions.onToggleLaunchAtLogin(item.checked)
      },
      { type: 'separator' },
      {
        label: '退出 FlowTray',
        click: () => this.actions.onQuit()
      }
    ])
    this.tray.setContextMenu(menu)
    this.tray.setToolTip(
      usage.itemCount > 0 ? `FlowTray · ${usage.itemCount} 项暂存` : 'FlowTray 流转台'
    )
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }
}
