import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

// Extend the immutable published CLI, never the unrelated private workspace edits.
const root = fileURLToPath(new URL('../', import.meta.url))
const base = fileURLToPath(new URL('../', import.meta.resolve('@utopia-studio-design/design-system-cli')))
const sourceVersion = JSON.parse(await readFile(join(root, 'package.json'))).version
const original = JSON.parse(await readFile(join(base, 'package.json')))
if (original.version !== '0.8.10') throw new Error('This integration build requires the reviewed published Ceramic CLI 0.8.10 baseline.')
const target = join(root, '.ceramic/ceramic-mcp-package')
await mkdir(target, { recursive: true })
await cp(base, target, { recursive: true, filter: path => !relative(base, path).split('/').includes('node_modules') })
const distribution = `https://github.com/The-Utopia-Studio/ceramic-doctor/releases/download/v${sourceVersion}/utopia-studio-design-design-system-cli-0.8.10-doctor.1.tgz`
const sourceArchive = `https://github.com/The-Utopia-Studio/ceramic-doctor/releases/download/v${sourceVersion}/utopia-studio-design-ceramic-doctor-source-${sourceVersion}.tgz`
const pkg = { ...original, version: '0.8.10-doctor.1', engines: { node: '>=22.17' }, ceramic: { ...original.ceramic, distribution },
  files: [...original.files, 'ceramic-doctor-integration.json'], dependencies: { ...original.dependencies, '@utopia-studio-design/ceramic-doctor-source': sourceArchive } }
await writeFile(join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
await cp(join(root, 'integrations/ceramic/stdio-adapter.mjs'), join(target, 'lib/source-review.mjs'))
const update = async (path, edits) => {
  const filename = join(target, path)
  let text = await readFile(filename, 'utf8')
  const before = text
  for (const [old, next] of edits) {
    if (!text.includes(old)) throw new Error(`Published Ceramic layout changed: ${path}`)
    text = text.replace(old, next)
  }
  await writeFile(filename, text)
  return { before: createHash('sha256').update(before).digest('hex'), after: createHash('sha256').update(text).digest('hex') }
}
const mcp = await update('bin/utopia-ds-mcp.mjs', [
  ['#!/usr/bin/env node\n', "#!/usr/bin/env node\nimport { codeToolDefinitions, reviewSourceFiles, verifySourceFixes, sourceReviewInstructions } from '../lib/source-review.mjs'\n"],
  ['const tools = [', "const tools = [\n  ...codeToolDefinitions.map(tool => [tool.name, tool.description, tool.inputSchema.properties, tool.name === 'review_files' ? reviewSourceFiles : verifySourceFixes]),"],
  ['instructions: guideInstructions +', "instructions: sourceReviewInstructions + '\\n' + guideInstructions +"],
  ['=> ({ name, description, inputSchema:', '=> (codeToolDefinitions.find(tool => tool.name === name) ?? { name, description, inputSchema:'],
  ["tool[0] === 'ceramic_guide' ? []", "(tool[0] === 'ceramic_guide' || codeToolDefinitions.some(item => item.name === tool[0])) ? []"],
  ['isError: data == null || data?.ok === false', 'isError: data == null || data?.ok === false || (codeToolDefinitions.some(item => item.name === tool[0]) && data.execution !== \'completed\')'],
])
const api = await update('lib/api.mjs', [
  ["export const cliVersion", "export async function reviewSourceFiles(input) { return (await import('./source-review.mjs')).reviewSourceFiles(input) }\nexport async function verifySourceFixes(input) { return (await import('./source-review.mjs')).verifySourceFixes(input) }\n\nexport const cliVersion"],
  ["tools: ['ceramic_guide'", "tools: ['review_files', 'verify_code_fixes', 'ceramic_guide'"],
])
await writeFile(join(target, 'ceramic-doctor-integration.json'), JSON.stringify({ basePackage: original.name, baseVersion: original.version, sourceVersion, distribution, modifiedModules: { mcp, api }, preserved: 'All other published CLI modules and catalog data are copied unchanged.' }, null, 2) + '\n')
const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', join(root, '.ceramic')], { cwd: target, encoding: 'utf8' }))[0]
console.log(JSON.stringify({ path: join(root, '.ceramic', result.filename), integrity: result.integrity, distribution, baseVersion: original.version, version: pkg.version }, null, 2))
