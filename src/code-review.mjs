import { Linter } from 'eslint'
import parser from '@typescript-eslint/parser'
import a11y from 'eslint-plugin-jsx-a11y'
import postcss from 'postcss'
import picomatch from 'picomatch'
import { extname, posix } from 'node:path'
import { hash, technicalScore } from './contracts.mjs'

export const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css'])
export const unsupportedUiExtensions = new Set(['.vue', '.svelte', '.swift', '.html', '.scss', '.sass', '.less'])
export const defaultPolicy = { version: 1, semanticTokens: false, pagePatterns: ['src/pages/**'], tokenPatterns: ['**/themes/**', '**/tokens/**', '**/core.css'], ignore: [] }

export function validatePolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(defaultPolicy, k))) throw new Error('Invalid .ceramic-review.json policy fields.')
  const policy = { ...defaultPolicy, ...value }
  if (policy.version !== 1 || typeof policy.semanticTokens !== 'boolean') throw new Error('Policy requires version 1 and a boolean semanticTokens setting.')
  for (const key of ['pagePatterns', 'tokenPatterns', 'ignore']) if (!Array.isArray(policy[key]) || policy[key].length > 20 || policy[key].some(p => typeof p !== 'string' || !p || p.length > 200)) throw new Error(`Invalid policy ${key}.`)
  return policy
}

export function validateFiles(files) {
  if (!Array.isArray(files) || files.length > 100) throw new Error('Supply up to 100 source files.')
  const names = new Set()
  let bytes = 0
  for (const file of files) {
    if (!file || Object.keys(file).some(k => !['path', 'content', 'changedLines'].includes(k))) throw new Error('Invalid source file fields.')
    if (typeof file.path !== 'string' || !file.path || file.path.length > 500 || file.path.includes('\\') || /[\x00-\x1f\x7f]/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..') || posix.normalize(file.path) !== file.path || names.has(file.path)) throw new Error('Source paths must be unique, normalized repository-relative paths.')
    if (!sourceExtensions.has(extname(file.path).toLowerCase()) && !unsupportedUiExtensions.has(extname(file.path).toLowerCase())) throw new Error(`Unsupported source extension: ${file.path}`)
    if (typeof file.content !== 'string' || file.content.includes('\0') || Buffer.byteLength(file.content) > 256 * 1024) throw new Error('Each source file must be UTF-8 text, at most 256 KiB.')
    bytes += Buffer.byteLength(file.content)
    if (file.changedLines !== undefined && (!Array.isArray(file.changedLines) || file.changedLines.length > 500 || file.changedLines.some(r => !r || Object.keys(r).some(k => !['start', 'end'].includes(k)) || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 1 || r.end < r.start))) throw new Error('Invalid changed-line ranges.')
    names.add(file.path)
  }
  if (bytes > 2 * 1024 * 1024) throw new Error('Source review exceeds the 2 MiB local payload limit.')
  return files
}

const jsxRules = { ...Object.fromEntries(Object.entries(a11y.configs.recommended.rules).filter(([, value]) => ![0, 'off'].includes(Array.isArray(value) ? value[0] : value))), 'jsx-a11y/control-has-associated-label': ['error', { ignoreElements: ['a', 'area', 'audio', 'canvas', 'embed', 'iframe', 'img', 'input', 'object', 'textarea', 'video'] }] }
const fixes = {
  'jsx-a11y/alt-text': 'Provide an accurate text alternative, or alt="" for a purely decorative image.',
  'jsx-a11y/anchor-has-content': 'Give the link a meaningful accessible name describing its destination.',
  'jsx-a11y/anchor-is-valid': 'Use a valid destination for navigation, or a semantic button for an action.',
  'jsx-a11y/click-events-have-key-events': 'Use the appropriate native button/link so keyboard activation is supported.',
  'jsx-a11y/no-static-element-interactions': 'Use the native semantic control, or implement the required role and keyboard contract.',
  'jsx-a11y/label-has-associated-control': 'Associate the label with its control using htmlFor/id or nesting.',
  'jsx-a11y/control-has-associated-label': 'Give the control an accessible name associated with its visible label.',
  'jsx-a11y/no-autofocus': 'Confirm focus is intentionally moved for the task; avoid stealing focus on initial page load.',
}

const ceramicRules = {
  'page-style-ownership': {
    meta: { type: 'problem', schema: [] },
    create(context) {
      return {
        ImportDeclaration(node) { if (typeof node.source.value === 'string' && /\.css(?:\?|$)/.test(node.source.value)) context.report({ node, message: 'Move CSS imports out of the page and into the registered component or pattern owner.' }) },
        JSXAttribute(node) { if (node.name.name === 'style') context.report({ node, message: 'Move presentation out of page inline styles and into the registered component or pattern owner.' }) },
      }
    },
  },
}

function matches(path, patterns) { return patterns.some(pattern => picomatch(pattern, { dot: true })(path)) }
function selected(file, line, endLine = line) { return file.changedLines === undefined || file.changedLines.some(r => r.start <= endLine && r.end >= line) }

function inspectJs(file, policy) {
  const rules = { ...jsxRules }
  let jsxElements = 0
  const surfaces = []
  const surfaceRule = { meta: { schema: [] }, create: () => ({ JSXOpeningElement() { jsxElements++ }, JSXElement(node) { surfaces.push({ start: node.openingElement.loc.start, openingEnd: node.openingElement.loc.end, end: node.loc.end }) } }) }
  rules['ceramic/jsx-surface'] = 'warn'
  if (policy.semanticTokens && matches(file.path, policy.pagePatterns)) rules['ceramic/page-style-ownership'] = 'error'
  const messages = new Linter({ configType: 'flat' }).verify(file.content, [{ files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'], languageOptions: {
    parser, ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true }, project: false },
  }, plugins: { 'jsx-a11y': a11y, ceramic: { rules: { ...ceramicRules, 'jsx-surface': surfaceRule } } }, rules,
    ...(policy.semanticTokens ? { settings: { 'jsx-a11y': { components: { Button: 'button', IconButton: 'button', Input: 'input', Textarea: 'textarea', NativeSelect: 'select' } } } } : {}),
  }], { filename: `review${extname(file.path).toLowerCase()}`, allowInlineConfig: false })
  const childSensitive = new Set(['jsx-a11y/control-has-associated-label', 'jsx-a11y/anchor-has-content', 'jsx-a11y/heading-has-content', 'jsx-a11y/label-has-associated-control', 'jsx-a11y/media-has-caption'])
  const contextualEnd = message => {
    if (!childSensitive.has(message.ruleId)) return message.endLine ?? message.line ?? 1
    const line = message.line ?? 1, column = (message.column ?? 1) - 1
    const surface = surfaces.filter(s => s.start.line <= line && s.openingEnd.line >= line && (s.start.line !== line || s.start.column <= column) && (s.openingEnd.line !== line || s.openingEnd.column >= column)).sort((a, b) => a.end.line - a.start.line - (b.end.line - b.start.line))[0]
    return Math.max(message.endLine ?? line, surface?.end.line ?? line)
  }
  return { relevant: jsxElements > 0 || messages.length > 0, rules: ['syntax', 'engine/inline-config', ...Object.keys(rules)], messages: messages.map(message => ({ rule: message.ruleId ?? (message.fatal ? 'syntax' : 'engine/inline-config'), severity: message.fatal ? 'serious' : message.severity === 1 || message.ruleId === 'jsx-a11y/no-autofocus' ? 'moderate' : 'serious',
    line: message.line ?? 1, column: message.column ?? 1, endLine: contextualEnd(message), message: message.message, fatal: Boolean(message.fatal),
    fix: fixes[message.ruleId] ?? (message.fatal ? 'Repair the syntax, then rerun source review; accessibility checks could not complete.' : 'Correct the semantic component/attribute contract described by this rule and rerun review.'),
    helpUrl: a11y.rules[message.ruleId?.replace('jsx-a11y/', '')]?.meta?.docs?.url,
  })) }
}

function inspectCss(file, policy) {
  const rules = ['syntax', 'css/focus-outline'], messages = []
  try {
    const tree = postcss.parse(file.content, { from: file.path })
    tree.walkRules(rule => {
      if (!/:focus(?:-visible)?\b/.test(rule.selector)) return
      const declarations = rule.nodes?.filter(node => node.type === 'decl') ?? []
      const hidden = declarations.find(d => d.prop === 'outline' && /^(none|0(?:px)?)\s*(?:!important)?$/i.test(d.value))
      if (hidden && !declarations.some(d => /^(box-shadow|border|outline|background-color)$/.test(d.prop) && d !== hidden && !/^(none|0|transparent)$/i.test(d.value))) messages.push({ rule: 'css/focus-outline', severity: 'moderate', line: hidden.source.start.line, column: hidden.source.start.column, endLine: rule.source.end.line,
        message: 'Focus outline is removed without a replacement in this rule. Confirm the computed focus indicator in a browser.', fix: 'Provide a visible focus indicator through the owning component or shared token; inspect inherited states before changing styles.' })
    })
    if (policy.semanticTokens && !matches(file.path, policy.tokenPatterns)) {
      rules.push('ceramic/raw-color')
      tree.walkDecls(d => {
        if (!d.prop.startsWith('--') && /(?:color|background|border|outline|shadow|fill|stroke)/i.test(d.prop) && /(?:#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\s*\()/i.test(d.value.replace(/url\([^)]*\)/gi, ''))) messages.push({ rule: 'ceramic/raw-color', severity: 'serious', line: d.source.start.line, column: d.source.start.column, endLine: d.source.end.line,
          message: 'A raw color bypasses the configured semantic-token contract.', fix: 'Use the registered semantic role; add missing visual roles to the shared contract rather than patching a page.' })
      })
    }
    return { rules, messages }
  } catch (error) { return { rules, messages: [{ rule: 'syntax', severity: 'serious', line: error.line ?? 1, column: error.column ?? 1, endLine: error.line ?? 1, message: error.reason ?? 'CSS could not be parsed.', fatal: true, fix: 'Repair CSS syntax and rerun review.' }] } }
}

export function reviewFiles(input) {
  if (!input || Object.keys(input).some(k => !['files', 'policy', 'context', 'failOn'].includes(k))) throw new Error('Invalid code-review input.')
  const files = validateFiles(input.files), policy = validatePolicy(input.policy), failOn = input.failOn ?? 'serious'
  if (!['critical', 'serious', 'moderate', 'minor'].includes(failOn)) throw new Error('Invalid failure threshold.')
  const findings = [], coverage = []
  for (const file of files) {
    if (matches(file.path, policy.ignore)) { coverage.push({ path: file.path, status: 'skipped', reason: 'Explicit policy exclusion', rules: [] }); continue }
    if (unsupportedUiExtensions.has(extname(file.path).toLowerCase())) { coverage.push({ path: file.path, status: 'blocked', reason: 'This UI language is not supported by the source engine.', rules: [] }); continue }
    const inspected = extname(file.path).toLowerCase() === '.css' ? inspectCss(file, policy) : inspectJs(file, policy)
    const overBudget = inspected.messages.length > Math.min(500, 2000 - findings.length)
    coverage.push({ path: file.path, status: inspected.messages.some(m => m.fatal) || overBudget ? 'blocked' : 'completed', ...(overBudget ? { reason: 'Finding budget exceeded; split the review into smaller explicit batches.' } : {}), relevant: inspected.relevant ?? true, rules: inspected.rules, contentHash: hash(file.content), scope: file.changedLines === undefined ? 'whole-file' : 'changed-lines', changedLines: file.changedLines })
    const occurrences = new Map()
    for (const message of inspected.messages.slice(0, Math.min(500, 2000 - findings.length))) {
      const key = `${message.rule}:${message.message}`
      const occurrence = occurrences.get(key) ?? 0; occurrences.set(key, occurrence + 1)
      if (!message.fatal && !selected(file, message.line, message.endLine)) continue
      findings.push({ ...message, id: hash([file.path, message.rule, message.message, occurrence]), file: file.path, category: message.rule.startsWith('ceramic/') ? 'semantic-contract' : message.rule === 'syntax' ? 'syntax' : 'accessibility', source: 'automated', title: message.message })
    }
  }
  const complete = coverage.every(c => c.status !== 'blocked'), active = coverage.some(c => c.status === 'completed' && c.relevant)
  const ranks = ['critical', 'serious', 'moderate', 'minor'], blocks = findings.some(f => ranks.indexOf(f.severity) <= ranks.indexOf(failOn))
  return { schemaVersion: 1, type: 'code-review', engine: 'ceramic-source-v1', scopeHash: hash({ files: files.map(f => ({ path: f.path, changedLines: f.changedLines })), policy }),
    context: input.context ?? {}, policy, failOn, execution: complete ? 'completed' : 'partial', verdict: blocks ? 'FAIL' : !complete ? 'BLOCKED' : !active ? 'SKIP' : findings.length ? 'PASS WITH RISKS' : 'PASS',
    score: technicalScore(findings, complete && active), findings, coverage,
    limits: ['Static JSX accessibility and configured source-contract checks only; no application code, repository ESLint config, npm scripts or source modules are executed.',
      'Source checks do not prove computed contrast, visual hierarchy, keyboard behavior, or responsive layout. Use browser evidence for those claims.',
      'UI framework wrappers and cross-file relationships may require human review. Unsupported UI languages block coverage instead of receiving a pass.',
      'Changed-line review does not approve unmodified code. Inline ESLint suppression comments are disabled for the review engine.',
      'Whole-file revalidation can expose findings outside an earlier diff. New means newly observed, not proven newly introduced.'] }
}

export function verifyCodeFixes({ previous, files, policy }) {
  if (!previous || previous.type !== 'code-review' || previous.engine !== 'ceramic-source-v1' || !Array.isArray(previous.findings) || !Array.isArray(previous.coverage)) throw new Error('Supply a previous Ceramic source report.')
  if (previous.findings.length > 5000 || previous.coverage.length > 100) throw new Error('Previous report exceeds verification limits.')
  const next = reviewFiles({ files, policy: policy ?? previous.policy, failOn: previous.failOn })
  if (hash(next.policy) !== hash(previous.policy)) throw new Error('Verification must preserve the original source policy.')
  const previousPaths = previous.coverage.filter(c => c.status !== 'skipped').map(c => c.path).sort()
  const nextPaths = next.coverage.filter(c => c.status !== 'skipped').map(c => c.path).sort()
  if (JSON.stringify(previousPaths) !== JSON.stringify(nextPaths) || files.some(f => f.changedLines !== undefined)) throw new Error('Revalidation requires whole-file contents for every originally reviewed file.')
  const fixed = [], present = [], unverified = [], oldIds = new Set(previous.findings.map(f => f.id))
  for (const item of previous.findings) {
    if (next.findings.some(f => f.id === item.id)) present.push(item.id)
    else {
      const cell = next.coverage.find(c => c.path === item.file)
      // When a sibling failure of the same rule remains, source movement/removal is
      // ambiguous. Do not declare a fix solely because a line/fingerprint changed.
      const safe = cell?.status === 'completed' && cell.rules.includes(item.rule) && !next.findings.some(f => f.file === item.file && f.rule === item.rule)
      ;(safe ? fixed : unverified).push(item.id)
    }
  }
  return { ...next, verification: { fixed, present, unverified, new: next.findings.filter(f => !oldIds.has(f.id)).map(f => f.id), allClear: fixed.length === previous.findings.length && next.findings.length === 0 && next.execution === 'completed' } }
}
