/**
 * Build the browser half as a DSH lazy-CJS module.
 * The template is plain JavaScript (no ESM import/export); this script wraps it
 * in the official ModuleLoader format and verifies the result parses.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const templatePath = join(root, 'src', 'client', 'factory.template.js')
const logicPath = join(root, 'src', 'client', 'logic.js')
const outputPath = join(root, 'lib', 'client.js')

const template = readFileSync(templatePath, 'utf8')
const logic = readFileSync(logicPath, 'utf8').replace(/^export\s+/gm, '')
for (const source of [template, logic]) {
  if (/^\s*(import|export)\s/m.test(source)) {
    throw new Error('client factory must not contain ESM import/export statements')
  }
}

const body = template.replace('__CLIENT_LOGIC__', logic)
if (body.includes('__CLIENT_LOGIC__')) throw new Error('client logic placeholder was not replaced')

const bundle = `window.__ModuleLoader__.load({
  id: '@fg-lab/amadeus-qq',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
${body}
  }
});
`

new vm.Script(bundle, { filename: 'lib/client.js' })

for (const marker of [
  'settings.section',
  "id: 'amadeus-qq'",
  "/api/amadeus-qq",
  "credentials: 'same-origin'",
  '打开 Web Console',
  '开始首次设置',
]) {
  if (!bundle.includes(marker)) throw new Error(`client bundle is missing required marker: ${marker}`)
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, bundle, 'utf8')
process.stdout.write(`built lib/client.js (${Buffer.byteLength(bundle)} bytes)\n`)
