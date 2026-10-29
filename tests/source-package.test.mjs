import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

test('portable source package reuses the exact Doctor engine without browser, network or circular CLI dependencies', async () => {
  execFileSync(process.execPath, ['scripts/pack-source.mjs'], { cwd: new URL('../', import.meta.url), stdio: 'pipe' })
  const root = new URL('../.ceramic/source-package/', import.meta.url)
  const pkg = JSON.parse(await readFile(new URL('package.json', root)))
  for (const name of ['playwright', '@sparticuz/chromium', '@vercel/blob', '@utopia-studio-design/design-system-cli', '@modelcontextprotocol/sdk']) assert.equal(pkg.dependencies[name], undefined)
  const integrity = JSON.parse(await readFile(new URL('source-integrity.json', root)))
  for (const [path, hash] of Object.entries(integrity.files)) {
    const content = await readFile(new URL(path, root))
    assert.equal(createHash('sha256').update(content).digest('hex'), hash)
    assert.deepEqual(content, await readFile(new URL('../' + path, import.meta.url)))
  }
})
