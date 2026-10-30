const { app, BrowserWindow, nativeImage } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '..', 'build', 'icon.svg'), 'utf8')
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      offscreen: true
    }
  })
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{width:1024px;height:1024px;display:block}
  </style></head><body>${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((resolve) => setTimeout(resolve, 250))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  mkdirSync(join(__dirname, '..', 'build'), { recursive: true })
  mkdirSync(join(__dirname, '..', 'resources'), { recursive: true })
  writeFileSync(join(__dirname, '..', 'build', 'icon.png'), image.toPNG())
  const full = nativeImage.createFromBuffer(image.toPNG())
  writeFileSync(
    join(__dirname, '..', 'build', 'icon-256.png'),
    full.resize({ width: 256, height: 256, quality: 'best' }).toPNG()
  )
  writeFileSync(
    join(__dirname, '..', 'resources', 'tray.png'),
    full.resize({ width: 64, height: 64, quality: 'best' }).toPNG()
  )
  console.log('icons written', image.getSize())
  win.destroy()
  app.quit()
})
