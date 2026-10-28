import { createHash } from 'node:crypto'

export const viewports = [
  { id: 'desktop', width: 1440, height: 900, isMobile: false, hasTouch: false },
  { id: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true },
]

export function httpUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials.')
  return url.href
}

export function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Review input must be an object.')
  input = structuredClone(input)
  const allowed = ['url', 'readySelector', 'scenarios', 'visual', 'qa', 'timeoutMs']
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown review input: ${key}`)
  const url = httpUrl(input.url)
  const visual = input.visual ?? 'none'
  if (!['none', 'codex'].includes(visual)) throw new Error('visual must be none or codex.')
  const qa = input.qa ?? 'none'
  if (!['none', 'browser', 'quick', 'contracts'].includes(qa)) throw new Error('qa must be none, browser, quick or contracts.')
  const timeoutMs = input.timeoutMs ?? 30_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) throw new Error('timeoutMs must be 1000–60000.')
  if (input.readySelector !== undefined && (typeof input.readySelector !== 'string' || !input.readySelector.trim() || input.readySelector.length > 500)) throw new Error('readySelector must be a non-empty selector, up to 500 characters.')
  const scenarios = input.scenarios ?? [{ id: 'initial', actions: [] }]
  if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > 8) throw new Error('Provide 1–8 scenarios.')
  const ids = new Set()
  for (const scenario of scenarios) {
    if (!scenario || Object.keys(scenario).some(key => !['id', 'actions', 'url', 'readySelector', 'locale', 'direction', 'reducedMotion'].includes(key))) throw new Error('Invalid scenario fields.')
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(scenario.id) || ids.has(scenario.id)) throw new Error('Scenario ids must be unique lowercase kebab-case names.')
    ids.add(scenario.id)
    if (scenario.url) {
      scenario.url = httpUrl(new URL(scenario.url, url).href)
      if (new URL(scenario.url).origin !== new URL(url).origin) throw new Error('Scenario URLs must share the review origin.')
    }
    if (scenario.locale && (typeof scenario.locale !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(scenario.locale))) throw new Error('Invalid scenario locale.')
    if (scenario.direction && !['ltr', 'rtl'].includes(scenario.direction)) throw new Error('direction must be ltr or rtl.')
    if (scenario.reducedMotion && !['reduce', 'no-preference'].includes(scenario.reducedMotion)) throw new Error('Invalid reducedMotion.')
    if (scenario.readySelector !== undefined && (typeof scenario.readySelector !== 'string' || !scenario.readySelector.trim() || scenario.readySelector.length > 500)) throw new Error('Invalid scenario readySelector.')
    if (!Array.isArray(scenario.actions) || scenario.actions.length > 20) throw new Error('Each scenario requires an actions array of at most 20 steps.')
    for (const action of scenario.actions) {
      if (!action || Object.keys(action).some(key => !['kind', 'selector', 'value'].includes(key)) || !['click', 'press', 'fill', 'select', 'expectVisible', 'expectText'].includes(action.kind)) throw new Error('Unsupported scenario action.')
      if (action.kind !== 'press' && (typeof action.selector !== 'string' || !action.selector.trim() || action.selector.length > 500)) throw new Error('Actions require a selector, up to 500 characters.')
      if (['fill', 'select', 'expectText', 'press'].includes(action.kind) && (typeof action.value !== 'string' || action.value.length > 2000)) throw new Error('Action requires a string value, up to 2000 characters.')
      if (action.kind === 'press' && !/^(Tab|Shift\+Tab|Escape|Enter|Space|ArrowDown|ArrowUp|ArrowLeft|ArrowRight|Home|End|PageDown|PageUp)$/.test(action.value)) throw new Error('Unsupported key.')
    }
  }
  return { url, ...(input.readySelector ? { readySelector: input.readySelector } : {}), scenarios: structuredClone(scenarios), visual, qa, timeoutMs }
}

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
export const scopeHash = input => hash({ url: input.url, scenarios: input.scenarios, readySelector: input.readySelector ?? null, viewports })

export function finding({ rule, category, severity, title, selector = '', scenario = 'library', evidence, fix, source = 'automated' }) {
  return { id: hash([source, rule, scenario, selector]), rule, category, severity, title, selector, scenario, source, fix, evidence: [evidence], validation: 'observed' }
}

export function mergeFindings(findings) {
  const unique = new Map()
  for (const item of findings) {
    if (unique.has(item.id)) unique.get(item.id).evidence.push(...item.evidence)
    else unique.set(item.id, structuredClone(item))
  }
  const order = ['critical', 'serious', 'moderate', 'minor']
  return [...unique.values()].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.id.localeCompare(b.id))
}

// This is a versioned technical defect index, never a visual-taste or release score.
export function technicalScore(findings, complete) {
  if (!complete) return { value: null, kind: 'automated', rubric: 'ceramic-technical-v1' }
  const weights = { critical: 25, serious: 10, moderate: 3, minor: 1 }
  let value = Math.max(0, 100 - findings.filter(f => f.source === 'automated').reduce((sum, f) => sum + weights[f.severity], 0))
  if (findings.some(f => f.source === 'automated' && f.severity === 'critical')) value = Math.min(59, value)
  return { value, kind: 'automated', rubric: 'ceramic-technical-v1' }
}

export function verifyFindings(previous, current) {
  if (previous.scopeHash !== current.scopeHash) throw new Error('Verification requires the same URL, scenarios, readiness and viewport scope.')
  const now = new Map(current.findings.map(f => [f.id, f]))
  const result = { fixed: [], present: [], unverified: [], new: [] }
  for (const item of previous.findings) {
    if (now.has(item.id)) result.present.push(item.id)
    else {
      const covered = current.coverage.some(c => c.scenario === item.scenario && c.status === 'completed' && c.checks?.includes(item.rule))
      // Model suggestions are not deterministic defects; absence is not proof of a fix.
      const verified = item.source === 'automated' && item.evidence.every(e => current.coverage.some(c => c.scenario === item.scenario && c.viewport === e.viewport && c.status === 'completed' && c.checks?.includes(item.rule))) && covered
      result[verified ? 'fixed' : 'unverified'].push(item.id)
    }
  }
  const old = new Set(previous.findings.map(f => f.id))
  result.new = current.findings.filter(f => !old.has(f.id)).map(f => f.id)
  result.allClear = result.present.length === 0 && result.unverified.length === 0 && current.execution === 'completed' && current.findings.length === 0
    && current.coverage.every(c => c.status === 'completed' && !c.incomplete?.length)
  return result
}
