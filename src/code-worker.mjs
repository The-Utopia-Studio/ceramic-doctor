import { parentPort, workerData } from 'node:worker_threads'
import { reviewFiles, verifyCodeFixes } from './code-review.mjs'
try { parentPort.postMessage({ result: workerData.kind === 'verify_code_fixes' ? verifyCodeFixes(workerData.input) : reviewFiles(workerData.input) }) }
catch (error) { parentPort.postMessage({ error: String(error.message).slice(0, 1500) }) }
