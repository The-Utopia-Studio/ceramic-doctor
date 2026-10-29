import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewFiles, verifyCodeFixes } from '../src/code-review.mjs'
import { githubAnnotations, codeSarif, codeExitCode } from '../src/code-report.mjs'
import { runCodeTool } from '../src/code-tools.mjs'

const file = content => ({ path: 'src/Card.tsx', content })
const bad = 'export const Card=()=> <>\n<img src="logo.png" />\n<button />\n</>'
const good = 'export const Card=()=> <>\n<img src="logo.png" alt="Company" />\n<button>Save</button>\n</>'

test('source review finds actionable JSX defects with exact file/line and does not execute code', () => {
  const report = reviewFiles({ files: [file(`throw new Error('must never execute');\n${bad}`)] })
  assert.equal(report.execution, 'completed')
  assert.equal(report.verdict, 'FAIL')
  assert.equal(codeExitCode(report), 1)
  assert.ok(report.findings.some(f => f.rule === 'jsx-a11y/alt-text' && f.file === 'src/Card.tsx' && f.line === 3))
  assert.ok(report.findings.some(f => f.rule === 'jsx-a11y/control-has-associated-label' && f.line === 4))
  assert.ok(report.findings.every(f => f.fix && f.source === 'automated'))
  assert.equal(reviewFiles({ files: [file(good)] }).verdict, 'PASS')
  assert.equal(reviewFiles({ files: [{ path: 'node_modules/demo/Card.tsx', content: bad }] }).verdict, 'FAIL', 'Explicit source is never silently ignored by ESLint directory defaults.')
  const disabled = reviewFiles({ files: [file('/* eslint-disable jsx-a11y/alt-text */\n' + bad)] })
  assert.ok(disabled.findings.some(f => f.rule === 'jsx-a11y/alt-text'))
})

test('changed-line scope excludes pre-existing defects while keeping new issues and syntax failures', () => {
  const report = reviewFiles({ files: [{ ...file(bad), changedLines: [{ start: 3, end: 3 }] }] })
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].rule, 'jsx-a11y/control-has-associated-label')
  assert.equal(reviewFiles({ files: [{ ...file('export const Broken=()=> <'), changedLines: [] }] }).execution, 'partial')
  assert.equal(reviewFiles({ files: [{ path: 'src/App.vue', content: '<template />' }] }).verdict, 'BLOCKED')
  assert.equal(reviewFiles({ files: [{ path: 'src/server.mjs', content: 'export const value=42' }] }).verdict, 'SKIP')
  const removedLabel = reviewFiles({ files: [file('export const Card=()=> <button>\n<span aria-hidden="true"/>\n</button>')].map(f => ({ ...f, changedLines: [{ start: 2, end: 3 }] })) })
  assert.ok(removedLabel.findings.some(f => f.rule === 'jsx-a11y/control-has-associated-label'), 'Removing a label below an unchanged opening tag remains in the changed JSX surface.')
})

test('Ceramic ownership and token checks are explicit, with declared token-definition exemptions', () => {
  const page = { path: 'src/pages/Home.tsx', content: 'import "./page.css"; export const Home=()=> <main style={{color:"red"}}>Welcome</main>' }
  assert.equal(reviewFiles({ files: [page] }).findings.length, 0)
  const policy = { semanticTokens: true }
  assert.ok(reviewFiles({ files: [page], policy }).findings.some(f => f.rule === 'ceramic/page-style-ownership'))
  assert.ok(reviewFiles({ files: [{ path: 'src/pattern.css', content: '.card { color: #ffffff; }' }], policy }).findings.some(f => f.rule === 'ceramic/raw-color'))
  assert.equal(reviewFiles({ files: [{ path: 'src/themes/brand.css', content: ':root { color: #ffffff; }' }], policy }).findings.length, 0)
  assert.equal(reviewFiles({ files: [{ path: 'src/focus.css', content: 'button:focus { outline: none; }' }] }).verdict, 'PASS WITH RISKS')
  assert.ok(reviewFiles({ files: [file('export const Card=()=> <Button />')], policy }).findings.some(f => f.rule === 'jsx-a11y/control-has-associated-label'))
})

test('revalidation verifies whole-file repairs, preserves moved findings and abstains for ambiguous siblings', () => {
  const before = reviewFiles({ files: [file(bad)] })
  const moved = verifyCodeFixes({ previous: before, files: [file('\n\n' + bad)] })
  assert.equal(moved.verification.fixed.length, 0)
  assert.equal(moved.verification.present.length, before.findings.length)
  const after = verifyCodeFixes({ previous: before, files: [file(good)] })
  assert.equal(after.verification.fixed.length, before.findings.length)
  assert.equal(after.verification.allClear, true)
  const siblings = reviewFiles({ files: [file('export const A=()=> <><img src="a"/><img src="b"/></>')] })
  const fewer = verifyCodeFixes({ previous: siblings, files: [file('export const A=()=> <><img src="b"/></>')] })
  assert.equal(fewer.verification.fixed.length, 0)
  assert.ok(fewer.verification.unverified.length)
  assert.throws(() => verifyCodeFixes({ previous: before, files: [] }))
  assert.throws(() => verifyCodeFixes({ previous: before, files: [file(good)], policy: { semanticTokens: true } }))
  assert.throws(() => verifyCodeFixes({ previous: before, files: [{ ...file(good), changedLines: [] }] }))
})

test('source limits, unsafe paths and executable policy fields are rejected; GitHub/SARIF output is escaped', () => {
  for (const path of ['../Card.tsx', '/tmp/Card.tsx', 'src/../Card.tsx', 'src\\Card.tsx', 'src/evil\nCard.tsx', '.env']) assert.throws(() => reviewFiles({ files: [{ path, content: bad }] }))
  assert.throws(() => reviewFiles({ files: [file('x'.repeat(300_000))] }))
  assert.throws(() => reviewFiles({ files: [file(good)], policy: { rules: 'execute-a-script' } }))
  const many = reviewFiles({ files: [file('export const Card=()=> <>' + '<img src="x"/>'.repeat(501) + '</>')] })
  assert.equal(many.execution, 'partial')
  assert.equal(many.score.value, null)
  assert.equal(many.findings.length, 500)
  const totalBudget = reviewFiles({ files: Array.from({ length: 5 }, (_, index) => ({ path: `src/Card${index}.tsx`, content: 'export const Card=()=> <>' + '<img src="x"/>'.repeat(index === 4 ? 500 : 499) + '</>' })) })
  assert.equal(totalBudget.execution, 'partial', 'The final file cannot silently truncate findings at the total report limit.')
  assert.equal(totalBudget.findings.length, 2000)
  const report = reviewFiles({ files: [{ path: 'src/Card,one.tsx', content: bad }] })
  const annotations = githubAnnotations({ ...report, findings: report.findings.map(f => ({ ...f, title: 'unsafe\n::error title=Injected::no' })) })
  assert.ok(annotations.every(a => !a.includes('\n') && a.includes('%0A') && a.includes('Card%2Cone.tsx')))
  assert.equal(codeSarif(report).runs[0].results[0].locations[0].physicalLocation.region.startLine, 2)
})

test('MCP source worker returns structured findings and enforces separate bounded payloads', async () => {
  const before = await runCodeTool('review_files', { files: [file(bad)] })
  assert.equal(before.verdict, 'FAIL')
  const after = await runCodeTool('verify_code_fixes', { previous: before, files: [file(good)] })
  assert.equal(after.verification.allClear, true)
  await assert.rejects(runCodeTool('review_files', { files: [file('x'.repeat(140_000))] }))
  await assert.rejects(runCodeTool('review_files', { files: [file(good)], program: 'untrusted' }))
})
