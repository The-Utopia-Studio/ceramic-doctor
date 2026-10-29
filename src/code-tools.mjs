import { Worker } from 'node:worker_threads'
import { validateFiles, validatePolicy } from './code-review.mjs'

const fileSchema = { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: {
  path: { type: 'string', maxLength: 500 }, content: { type: 'string', maxLength: 131072 },
  changedLines: { type: 'array', maxItems: 500, items: { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } } } },
} }
const files = { type: 'array', maxItems: 20, items: fileSchema }
const policy = { type: 'object', additionalProperties: false, properties: { version: { type: 'integer', enum: [1] }, semanticTokens: { type: 'boolean' }, pagePatterns: { type: 'array', items: { type: 'string' }, maxItems: 20 }, tokenPatterns: { type: 'array', items: { type: 'string' }, maxItems: 20 }, ignore: { type: 'array', items: { type: 'string' }, maxItems: 20 } } }
export const codeToolDefinitions = [
  { name: 'review_files', description: 'Review changed UI source directly, without a URL. Accept JSX/TSX, JavaScript/TypeScript containing JSX, and CSS. Return file/line findings, fix proposals, a technical score and coverage. No submitted code or project config is executed; source is not persisted. Changed-line ranges restrict findings; omitted ranges inspect the whole file. Use before committing/pushing or merging a PR. Send only the UI files authorized for review.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['files'], properties: { files, policy, failOn: { type: 'string', enum: ['critical', 'serious', 'moderate', 'minor'] } } }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'verify_code_fixes', description: 'Revalidate a previous Ceramic source report against updated whole-file contents for every original file. Return fixed, present, new and unverified findings. Moved lines and ambiguous remaining failures never prove a fix. Reports supplied by the caller are comparisons, not signed GitHub build attestations.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['previous', 'files'], properties: { previous: { type: 'object' }, files, policy } }, annotations: { readOnlyHint: true, openWorldHint: false } },
]

export function validateCodeToolInput(kind, input) {
  const definition = codeToolDefinitions.find(tool => tool.name === kind)
  if (!definition || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(definition.inputSchema.properties, key)) || definition.inputSchema.required.some(key => input[key] === undefined)) throw new Error('Invalid source-review tool arguments.')
  if (!Array.isArray(input.files) || input.files.length > 20 || input.files.some(f => typeof f?.content !== 'string' || Buffer.byteLength(f.content) > 128 * 1024) || Buffer.byteLength(JSON.stringify(input)) > 500 * 1024) throw new Error('Source MCP calls allow 20 files, 128 KiB each, and a 500 KiB total payload. Split larger reviews into explicit batches.')
  validateFiles(input.files)
  if (input.policy !== undefined) validatePolicy(input.policy)
}

export async function runCodeTool(kind, input) {
  validateCodeToolInput(kind, input)
  return new Promise((resolve, reject) => {
    let settled = false
    const worker = new Worker(new URL('./code-worker.mjs', import.meta.url), { workerData: { kind, input }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } })
    const timer = setTimeout(() => { settled = true; void worker.terminate(); reject(new Error('Source review exceeded its 15-second budget; no pass is issued.')) }, 15_000)
    const finish = () => { clearTimeout(timer); void worker.terminate() }
    worker.once('message', message => { settled = true; finish(); message.error ? reject(new Error(message.error)) : resolve(message.result) })
    worker.once('error', () => { settled = true; finish(); reject(new Error('Source review worker failed; no pass is issued.')) })
    worker.once('exit', () => { clearTimeout(timer); if (!settled) reject(new Error('Source review worker stopped; no pass is issued.')) })
  })
}
