import { readFileSync, writeFileSync } from 'node:fs'

const png = readFileSync('build/icon-256.png')
const header = Buffer.alloc(6 + 16)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)
// ICONDIRENTRY
header[6] = 0 // width 256
header[7] = 0 // height 256
header[8] = 0 // color palette
header[9] = 0 // reserved
header.writeUInt16LE(1, 10) // planes
header.writeUInt16LE(32, 12) // bpp
header.writeUInt32LE(png.length, 14)
header.writeUInt32LE(22, 18)
writeFileSync('build/icon.ico', Buffer.concat([header, png]))
console.log('ico written', png.length + 22)
