import { randomBytes, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { put, get, list, del } from '@vercel/blob'

const access = { access: 'private', addRandomSuffix: false, allowOverwrite: false }
const capabilityPattern = /^\d{4}-\d{2}-\d{2}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.[a-f0-9]{64}$/
export const reportPath = id => {
  if (typeof id !== 'string' || !capabilityPattern.test(id)) throw new Error('Use the complete private reviewId returned by design_review.')
  return `reviews/${id.slice(0, 10)}/${id}.json`
}

export function createRemoteStore(blob = { put, get, list, del }) {
  return {
    async save(report) {
      const id = `${new Date().toISOString().slice(0, 10)}.${report.id}.${randomBytes(32).toString('hex')}`
      const screenshots = {}, browserEvidence = {}
      let bytes = 0
      for (const scenario of report.input.scenarios) for (const viewport of ['desktop', 'mobile']) {
        const name = `${scenario.id}-${viewport}`
        try {
          const image = await readFile(join(report.artifacts.directory, `${name}.png`))
          if (image.length <= 2 * 1024 * 1024 && bytes + image.length <= 6 * 1024 * 1024) { screenshots[name] = image.toString('base64'); bytes += image.length }
          else report.limitations.push(`Inline screenshot ${name} exceeded the hosted evidence budget.`)
        } catch {}
        try { browserEvidence[name] = JSON.parse(await readFile(join(report.artifacts.directory, `${name}.json`), 'utf8')) } catch {}
      }
      const remoteReport = { ...report, id, browserEvidence, artifacts: { storage: 'private', screenshotTool: 'get_screenshot' }, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() }
      // Never expose temporary server paths through a report or its browser errors.
      const sanitize = value => JSON.parse(JSON.stringify(value).split(report.artifacts.directory).join('[private-evidence]'))
      const envelope = sanitize({ report: remoteReport, screenshots, browserEvidence })
      await blob.put(reportPath(id), JSON.stringify(envelope), { ...access, contentType: 'application/json', cacheControlMaxAge: 60 })
      return envelope.report
    },
    async read(id) {
      const result = await blob.get(reportPath(id), { access: 'private', useCache: false })
      if (!result || result.statusCode !== 200 || result.blob.size > 14 * 1024 * 1024) throw new Error('Review unavailable or expired.')
      const envelope = await new Response(result.stream).json()
      if (envelope.report.id !== id || Date.parse(envelope.report.expiresAt) < Date.now()) throw new Error('Review unavailable or expired.')
      return envelope
    },
    async reserve(ip) {
      const now = new Date(), day = now.toISOString().slice(0, 10)
      const identity = createHmac('sha256', process.env.BLOB_READ_WRITE_TOKEN || 'development-only').update(ip).digest('hex')
      // Private fixed-path writes reject existing objects atomically at Blob storage.
      await blob.put(`budgets/${day}/ip-${identity}-${Math.floor(now.getTime() / 60_000)}`, '1', access).catch(() => { throw new Error('One remote review per minute per caller. Try again shortly.') })
      for (let slot = 0; slot < 30; slot++) {
        try { await blob.put(`budgets/${day}/hour-${Math.floor(now.getTime() / 3_600_000)}-${slot}`, '1', access); return }
        catch (error) { if (!/already exists|overwrite|pathname|conflict/i.test(error.message)) throw new Error('Hosted review budget could not be established.') }
      }
      throw new Error('The shared anonymous review budget is full for this hour. Please try later.')
    },
    async cleanup() {
      const cutoff = new Date(Date.now() - 48 * 60 * 60_000).toISOString().slice(0, 10)
      let removed = 0
      for (const prefix of ['reviews/', 'budgets/']) {
        let cursor
        do {
          const page = await blob.list({ prefix, cursor, limit: 1000 })
          const expired = page.blobs.filter(item => item.pathname.slice(prefix.length, prefix.length + 10) <= cutoff)
          if (expired.length) { await blob.del(expired.map(item => item.url)); removed += expired.length }
          cursor = page.hasMore ? page.cursor : undefined
        } while (cursor)
      }
      return { removed }
    },
  }
}
