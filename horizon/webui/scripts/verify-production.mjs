import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../dist')
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await check(path)
    else {
      assert(!/mockServiceWorker|demo-browser/i.test(entry.name), `Demo artifact: ${path}`)
      if (/\.(js|html|json|map)$/.test(entry.name)) {
        const contents = await readFile(path, 'utf8')
        for (const marker of [
          '__horizon_demo__',
          'fiction-member-',
          'fiction-project-',
          'fiction-company-',
          'Fable Works',
          'Mira Solen',
          'Lantern Atlas',
          'fictional-demo-v1:',
          'Fictional demo environment',
          'mockServiceWorker.js',
          'msw/browser',
        ]) {
          assert(!contents.includes(marker), `Production includes demo marker ${marker}: ${path}`)
        }
      }
    }
  }
}
await check(root)
console.log(
  'PASS: production output excludes demo runtime, fixtures, reserved API paths, and MSW worker.',
)
