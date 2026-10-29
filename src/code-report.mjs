import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const markdown = value => String(value ?? '').replace(/&/g, '&amp;').replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;').replace(/[\\`*_\[\]|]/g, '\\$&').replace(/[\r\n]/g, ' ')
export function codeMarkdown(report) {
  return `# Ceramic Doctor — ${report.verdict}\n\nExecution: ${report.execution} · Technical score: ${report.score.value ?? 'unavailable'}\n\n${report.context?.head ? `Head: ${markdown(report.context.head)}\n\n` : ''}${report.context?.base ? `Base: ${markdown(report.context.base)}\n\n` : ''}| Severity | File | Rule | Finding |\n| --- | --- | --- | --- |\n${report.findings.map(f => `| ${f.severity} | ${markdown(f.file)}:${f.line} | ${markdown(f.rule)} | ${markdown(f.title)} |`).join('\n') || '| — | — | — | No findings in the executed source scope. |'}\n\n${report.findings.map(f => `- ${markdown(f.file)}:${f.line}: ${markdown(f.fix)}`).join('\n')}\n\n## Coverage\n\n${report.coverage.map(c => `- ${markdown(c.path)}: ${c.status}${c.reason ? ` — ${markdown(c.reason)}` : ''}`).join('\n') || '- No supported UI changes.'}\n\n${report.collectionIssues?.length ? `## Unreviewed changes\n\n${report.collectionIssues.map(i => `- ${markdown(i.path)}: ${markdown(i.message)}`).join('\n')}\n\n` : ''}## Scope limits\n\n${report.limits.map(l => '- ' + markdown(l)).join('\n')}\n`
}

export function codeSarif(report) {
  const rules = [...new Map(report.findings.map(f => [f.rule, { id: f.rule, shortDescription: { text: f.rule }, ...(f.helpUrl ? { helpUri: f.helpUrl } : {}) }])).values()]
  return { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: 'Ceramic Doctor', version: '0.3.0', informationUri: 'https://github.com/The-Utopia-Studio/ceramic-doctor', rules } },
    invocations: [{ executionSuccessful: report.execution === 'completed' }], results: report.findings.map(f => ({ ruleId: f.rule, level: ['critical', 'serious'].includes(f.severity) ? 'error' : 'warning', message: { text: `${f.title}\n${f.fix}` },
      partialFingerprints: { 'ceramic/v1': f.id }, locations: [{ physicalLocation: { artifactLocation: { uri: f.file.split('/').map(encodeURIComponent).join('/'), uriBaseId: '%SRCROOT%' }, region: { startLine: f.line, startColumn: f.column ?? 1 } } }] })) }] }
}

const commandValue = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const propertyValue = value => commandValue(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
export function githubAnnotations(report) {
  return report.findings.slice(0, 50).map(f => `::${['critical', 'serious'].includes(f.severity) ? 'error' : 'warning'} file=${propertyValue(f.file)},line=${f.line},col=${f.column ?? 1},title=${propertyValue(`Ceramic Doctor: ${f.rule}`)}::${commandValue(f.title + ' ' + f.fix)}`)
    .concat(report.coverage.filter(c => c.status === 'blocked').slice(0, 10).map(c => `::error file=${propertyValue(c.path)},title=Ceramic Doctor coverage::${commandValue(c.reason ?? 'Source checks did not complete for this file.')}`))
    .concat(report.collectionIssues?.length ? [`::error title=Ceramic Doctor coverage::${commandValue('Some changed UI files could not be reviewed. See the report artifact.')}`] : [])
}

export async function saveCodeReport(report, { projectRoot = process.cwd(), outputDirectory, github = false } = {}) {
  const directory = outputDirectory ? resolve(outputDirectory) : resolve(projectRoot, '.ceramic/code-reviews', randomUUID())
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const md = codeMarkdown(report)
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  await writeFile(join(directory, 'report.md'), md, { mode: 0o600 })
  await writeFile(join(directory, 'report.sarif'), JSON.stringify(codeSarif(report), null, 2) + '\n', { mode: 0o600 })
  if (github && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + '\n')
  return directory
}

export const codeExitCode = report => report.execution !== 'completed' ? 2 : report.verdict === 'FAIL' ? 1 : 0
