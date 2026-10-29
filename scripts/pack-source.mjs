import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Package the very same engine used by Doctor, without its browser/CLI dependencies.
// Consumers run it in their own server; submitted source never crosses to Doctor.
const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const destination = join(root, '.ceramic/source-package')
const modules = ['code-review.mjs', 'code-tools.mjs', 'code-worker.mjs', 'contracts.mjs']
const dependencies = ['@typescript-eslint/parser', 'eslint', 'eslint-plugin-jsx-a11y', 'picomatch', 'postcss', 'typescript']
await mkdir(join(destination, 'src'), { recursive: true })
const hashes = {}
for (const name of modules) {
  const content = await readFile(join(root, 'src', name))
  await writeFile(join(destination, 'src', name), content)
  hashes[`src/${name}`] = createHash('sha256').update(content).digest('hex')
}
await cp(join(root, 'LICENSE'), join(destination, 'LICENSE'))
await writeFile(join(destination, 'package.json'), JSON.stringify({
  name: '@utopia-studio-design/ceramic-doctor-source', version: pkg.version,
  description: 'Bounded, offline Ceramic Doctor source review for existing MCP servers.',
  type: 'module', license: pkg.license, repository: pkg.repository, engines: pkg.engines,
  exports: { '.': './src/code-tools.mjs', './engine': './src/code-review.mjs' },
  files: ['src', 'LICENSE', 'source-integrity.json'],
  dependencies: Object.fromEntries(dependencies.map(name => [name, pkg.dependencies[name]])),
}, null, 2) + '\n')
await writeFile(join(destination, 'source-integrity.json'), JSON.stringify({ version: pkg.version, files: hashes }, null, 2) + '\n')
const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', join(root, '.ceramic')], { cwd: destination, encoding: 'utf8' }))[0]
console.log(JSON.stringify({ path: join(root, '.ceramic', result.filename), integrity: result.integrity, sourceFiles: hashes }, null, 2))
