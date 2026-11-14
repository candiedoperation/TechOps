import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const mode = process.env.VITE_HORIZON_DATA_SOURCE === 'api' ? 'api' : 'mock'
let fixtureChunks = 0
const root = resolve(import.meta.dirname, '../dist')
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await check(path)
    else {
      assert(!/mockServiceWorker|demo-browser/i.test(entry.name), `Demo artifact: ${path}`)
      if (/\.(js|html|json|map)$/.test(entry.name)) {
        const contents = await readFile(path, 'utf8')
        if (contents.includes('Avery Example')) {
          assert(
            mode === 'mock' && /^fixtures-.*\.js$/.test(entry.name),
            `Fixture outside the mock chunk: ${path}`,
          )
          fixtureChunks++
        }
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
assert.equal(fixtureChunks, mode === 'api' ? 0 : 1, 'Unexpected fixture chunk count')
console.log(`PASS: ${mode} build isolates Horizon fixtures and excludes the legacy MSW demo.`)
