const { app, globalShortcut } = require('electron')
app.whenReady().then(() => {
  const candidates = [
    'Control+Shift+Space',
    'Control+Alt+Space',
    'Control+Shift+F12',
    'Control+Alt+F12',
    'Control+Shift+Backquote',
    'Control+Alt+Backquote',
    'Control+Shift+KeyV',
    'Control+Alt+V',
    'Alt+Space'
  ]
  for (const accelerator of candidates) {
    let ok = false
    try { ok = globalShortcut.register(accelerator, () => {}) } catch (error) { ok = false }
    console.log(accelerator, ok)
    if (ok) globalShortcut.unregister(accelerator)
  }
  globalShortcut.unregisterAll()
  app.quit()
})
