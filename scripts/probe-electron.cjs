const electron = require('electron')
console.log('KEYS', Object.keys(electron).sort().join(','))
console.log('app', typeof electron.app, 'protocol', typeof electron.protocol, 'Menu', typeof electron.Menu, 'clipboard', typeof electron.clipboard)
if (electron.app) {
  console.log('READY?', electron.app.isReady())
}
