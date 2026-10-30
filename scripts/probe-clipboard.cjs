const { app, clipboard, ClipboardItem } = require('electron')
const { pathToFileURL } = require('node:url')

app.whenReady().then(async () => {
  const files = [
    'C:\\Users\\yjx12\\Documents\\2901Project\\FlowTray\\docs\\probe-a.txt',
    'C:\\Users\\yjx12\\Documents\\2901Project\\FlowTray\\docs\\probe-b.txt'
  ]
  const uriList = files.map((file) => pathToFileURL(file).toString()).join('\r\n')
  await clipboard.write([
    new ClipboardItem({
      'text/plain': files.join('\r\n'),
      'text/uri-list': uriList,
      'text/html': `<a href="${pathToFileURL(files[0])}">probe-a.txt</a>`
    })
  ])
  console.log('wrote uri-list; types now:')
  const items = await clipboard.read()
  for (const item of items) {
    console.log(JSON.stringify(item.types))
    for (const type of item.types) {
      const value = await item.getType(type)
      if (value instanceof Blob) {
        console.log('BLOB', type, value.size, (await value.text()).slice(0, 160).replace(/[\r\n]/g, '\\n'))
      }
    }
  }
  setTimeout(() => app.quit(), 2500)
})
