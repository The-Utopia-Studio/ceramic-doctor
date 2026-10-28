import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runDoctor, review, readReview, listReviews, verifyReview } from './review.mjs'

const scenarioSchema = { type: 'object', additionalProperties: false, required: ['id', 'actions'], properties: {
  id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' }, url: { type: 'string' }, readySelector: { type: 'string' },
  locale: { type: 'string' }, direction: { type: 'string', enum: ['ltr', 'rtl'] }, reducedMotion: { type: 'string', enum: ['reduce', 'no-preference'] },
  actions: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['kind'], properties: {
    kind: { type: 'string', enum: ['click', 'press', 'fill', 'select', 'expectVisible', 'expectText'] }, selector: { type: 'string' }, value: { type: 'string' },
  } } },
} }
const properties = { url: { type: 'string', description: 'HTTP(S) target, including localhost. Fresh unauthenticated browser; only explicit scenario actions are activated.' },
  readySelector: { type: 'string', description: 'Visible selector identifying a ready app state. Set this for hydrated apps.' },
  visual: { type: 'string', enum: ['none', 'codex'], default: 'none', description: 'codex sends captured screenshots to the signed-in Codex model and uses its allowance.' },
  qa: { type: 'string', enum: ['none', 'browser', 'quick', 'contracts'], default: 'none', description: 'Opt-in execution of the existing Ceramic project QA gate.' },
  scenarios: { type: 'array', minItems: 1, maxItems: 8, items: scenarioSchema }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
}
const schema = (props, required) => ({ type: 'object', additionalProperties: false, properties: props, required })
export const toolDefinitions = [
  { name: 'doctor', description: 'Check Ceramic library contracts. Include url to run Ceramic Design Review: browser accessibility/responsive evidence, optional visual judgement and fix proposals. No source repair or publication.', inputSchema: schema(properties, []), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'design_review', description: 'Review a URL in desktop/mobile Chromium. Reuses Ceramic Doctor and optional existing QA gates. Saves local evidence, stable findings, technical score and scoped fix proposals. Use visual=codex for screenshot judgement. Explicit scenario actions should target a test environment.', inputSchema: schema(properties, ['url']), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'verify_fixes', description: 'Rerun a saved review with identical URL/scenarios. Return fixed, present, unverified and new findings. An unavailable check never counts as fixed. Model suggestions require human confirmation.', inputSchema: schema({ reviewId: { type: 'string' } }, ['reviewId']), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'list_reviews', description: 'List the last 20 local review runs in this project.', inputSchema: schema({}, []), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_review', description: 'Read a saved report, coverage, fix proposals and artifact paths.', inputSchema: schema({ reviewId: { type: 'string' } }, ['reviewId']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_screenshot', description: 'Return one saved review screenshot inline. Scenario and viewport must be recorded by this run.', inputSchema: schema({ reviewId: { type: 'string' }, scenario: { type: 'string' }, viewport: { type: 'string', enum: ['desktop', 'mobile'] } }, ['reviewId', 'scenario', 'viewport']), annotations: { readOnlyHint: true, openWorldHint: false } },
]

export async function startMcp(projectRoot) {
  const server = new Server({ name: 'ceramic-doctor', version: '0.1.0' }, { capabilities: { tools: {} },
    instructions: 'Ceramic Doctor provides evidence-backed design review. Call doctor without url for library diagnostics, or design_review with a URL. Default checks are local and do not call a model. visual=codex is optional and consumes the local Codex allowance. For hydrated apps supply readySelector. Fix source under its existing semantic contracts, then verify_fixes using the original reviewId. Never treat skipped checks, an unavailable model, or a technical score as visual approval. Report execution separately from verdict. The server writes reports only under its configured project root.' })
  let active = false
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let progressTimer
    try {
      const tool = toolDefinitions.find(t => t.name === request.params.name)
      if (!tool) throw new Error('Unknown Ceramic Doctor tool.')
      const input = request.params.arguments ?? {}
      if (Object.keys(input).some(key => !Object.hasOwn(tool.inputSchema.properties, key)) || tool.inputSchema.required.some(key => input[key] === undefined)) throw new Error('Invalid tool arguments.')
      let data
      if (tool.name === 'get_screenshot') {
        const report = await readReview(input.reviewId, projectRoot)
        const cell = report.coverage.find(c => c.scenario === input.scenario && c.viewport === input.viewport && c.status === 'completed')
        if (!cell || !report.input.scenarios.some(s => s.id === input.scenario) || !['desktop', 'mobile'].includes(input.viewport)) throw new Error('No completed screenshot exists for this cell.')
        // Resolve from trusted root and validated ids; stored absolute artifact paths are never followed.
        const path = join(projectRoot, '.ceramic/design-reviews', report.id, `${input.scenario}-${input.viewport}.png`)
        const bytes = await readFile(path)
        if (bytes.length > 8 * 1024 * 1024) throw new Error('Screenshot is too large for inline delivery. Use the local artifact.')
        return { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }] }
      }
      if (tool.name === 'list_reviews') data = { reviews: await listReviews(projectRoot) }
      else if (tool.name === 'get_review') data = await readReview(input.reviewId, projectRoot)
      else if (tool.name === 'doctor' && input.url === undefined) {
        if (Object.keys(input).length) throw new Error('Review options require a URL.')
        data = await runDoctor(projectRoot)
      } else {
        if (active) throw new Error('A review is already running. Use list_reviews to inspect it.')
        active = true
        const progressToken = request.params._meta?.progressToken
        let progress = 0
        if (progressToken !== undefined) progressTimer = setInterval(() => {
          void extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++progress, message: 'Ceramic review running. Completed evidence is saved locally.' } }).catch(() => {})
        }, 5000)
        try { data = tool.name === 'verify_fixes' ? await verifyReview(input.reviewId, { projectRoot, signal: extra.signal }) : await review(input, { projectRoot, signal: extra.signal }) }
        finally { active = false }
      }
      // A completed review that finds defects is a valid tool result, not a transport failure.
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: data.execution ? data.execution !== 'completed' : data.ok === false }
    } catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true } }
    finally { clearInterval(progressTimer) }
  })
  await server.connect(new StdioServerTransport())
  return server
}
