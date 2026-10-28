import fs from 'node:fs'

// Shipped, static assets. Runtime values are fetched only after the Host's
// same-origin DSH Owner admission in admin-http.js.
const asset = name => fs.readFileSync(new URL(`./console/${name}`, import.meta.url), 'utf8')

export const CONSOLE_HTML = asset('index.html')
export const CONSOLE_CSS = asset('console.css')
export const CONSOLE_JS = asset('console.js')
