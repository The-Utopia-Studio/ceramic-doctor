import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeInput, finding, mergeFindings, scopeHash, technicalScore, verifyFindings } from '../src/contracts.mjs'
import { validateVisualResult } from '../src/model.mjs'

test('rejects unsafe protocols, duplicate states, cross-origin scenarios and unsupported actions', () => {
  for (const input of [
    { url: 'file:///etc/passwd' }, { url: 'http://user:secret@example.com' }, { url: 'https://example.com', timeoutMs: NaN },
    { url: 'https://example.com', visual: 'invent-a-score' }, { url: 'https://example.com', unexpected: true },
    { url: 'https://example.com', scenarios: [{ id: '../escape', actions: [] }] },
    { url: 'https://example.com', scenarios: [{ id: 'a', actions: [] }, { id: 'a', actions: [] }] },
    { url: 'https://example.com', scenarios: [{ id: 'a', url: 'https://other.example.com', actions: [] }] },
    { url: 'https://example.com', scenarios: [{ id: 'a', actions: [{ kind: 'eval', value: 'process.exit()' }] }] },
    { url: 'https://example.com', scenarios: [{ id: 'a', actions: [{ kind: 'press', value: 'Control+Q' }] }] },
  ]) assert.throws(() => normalizeInput(input))
})

test('stable findings deduplicate viewports and technical score excludes model opinions', () => {
  const base = { rule: 'button-name', category: 'accessibility', severity: 'critical', title: 'Name', scenario: 'initial', selector: '#button', fix: 'Name the button.' }
  const first = finding({ ...base, evidence: { viewport: 'desktop' } }), second = finding({ ...base, evidence: { viewport: 'mobile' } })
  const merged = mergeFindings([first, second])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].evidence.length, 2)
  assert.ok(technicalScore(merged, true).value <= 59)
  assert.equal(technicalScore([{ ...first, source: 'model-suggestion' }], true).value, 100)
  assert.equal(technicalScore([], false).value, null)
})

test('missing coverage, a failed browser or an absent model suggestion never prove a fix', () => {
  const input = normalizeInput({ url: 'https://example.com' }), scope = scopeHash(input)
  const old = finding({ rule: 'button-name', category: 'accessibility', title: 'Name', severity: 'critical', scenario: 'initial', evidence: { viewport: 'desktop' } })
  const previous = { scopeHash: scope, findings: [old] }
  const current = { scopeHash: scope, execution: 'partial', findings: [], coverage: [{ scenario: 'initial', viewport: 'desktop', status: 'blocked', checks: [] }] }
  assert.deepEqual(verifyFindings(previous, current).unverified, [old.id])
  current.execution = 'completed'; current.coverage[0] = { scenario: 'initial', viewport: 'desktop', status: 'completed', checks: ['button-name'] }
  assert.deepEqual(verifyFindings(previous, current).fixed, [old.id])
  previous.findings[0].source = 'model-suggestion'
  assert.deepEqual(verifyFindings(previous, current).unverified, [old.id])
  assert.throws(() => verifyFindings(previous, { ...current, scopeHash: 'different' }))
})

test('model output is limited to captured screens and remains a suggestion', () => {
  const screens = [{ coverage: { scenario: 'initial', viewport: 'mobile' }, screenshot: 'initial-mobile.png' }]
  const output = { summary: 'Clipped heading', findings: [{ scenario: 'initial', viewport: 'mobile', rule: 'clipping', severity: 'moderate', location: 'Top heading', title: 'Heading clips', evidence: 'Last word is outside the canvas', fix: 'Repair the owning layout.' }] }
  assert.equal(validateVisualResult(output, screens).findings[0].source, 'model-suggestion')
  assert.throws(() => validateVisualResult({ ...output, findings: [{ ...output.findings[0], scenario: 'invented' }] }, screens))
  assert.throws(() => validateVisualResult({ ...output, findings: [{ ...output.findings[0], severity: 'pass' }] }, screens))
})
