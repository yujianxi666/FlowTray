const { rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

/**
 * electron-builder afterPack hook.
 *
 * FlowTray always uses software rendering (see app.disableHardwareAcceleration)
 * and does not use Dawn/WebGPU. Removing these optional Electron runtime files
 * cuts roughly 39 MB from the unpacked app and ~15 MB from the installer.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const appOutDir = context.appOutDir
  const removable = [
    'chrome_200_percent.pak',
    'dxcompiler.dll',
    'd3dcompiler_47.dll'
  ]
  for (const name of removable) {
    const target = join(appOutDir, name)
    try {
      const size = statSync(target).size
      rmSync(target, { force: true })
      console.log(`  • pruned ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
    } catch {
      // File may not exist in a future Electron build; pruning is best effort.
    }
  }
}
