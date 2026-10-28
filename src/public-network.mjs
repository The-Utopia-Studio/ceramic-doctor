import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import ipaddr from 'ipaddr.js'

export function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast' } catch { return false }
}

export async function resolvePublicUrl(value, resolver = lookup) {
  const url = new URL(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Remote review requires public HTTP(S) on port 80 or 443, without URL credentials.')
  if (hostname === 'localhost' || /\.(?:localhost|local|internal|home|test|invalid)$/i.test(hostname) || !hostname.includes('.') && !ipaddr.isValid(hostname)) throw new Error('Private and local targets are unavailable on the remote server.')
  const records = ipaddr.isValid(hostname) ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4 }] : await resolver(hostname, { all: true, verbatim: true })
  if (!records.length || records.some(record => !isPublicAddress(record.address))) throw new Error('Target DNS resolves to a non-public address.')
  return { url, address: records[0].address, family: records[0].family }
}

// Browser requests are fulfilled through a DNS-pinned HTTP proxy. The browser never
// resolves an approved hostname a second time, including redirects/subresources.
export async function publicFetch(value, { headers = {}, maxBytes = 8 * 1024 * 1024, resolver } = {}) {
  const target = await resolvePublicUrl(value, resolver)
  return new Promise((resolveResult, reject) => {
    const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => !['host', 'connection', 'content-length', 'authorization', 'proxy-authorization', 'accept-encoding'].includes(key.toLowerCase())))
    safeHeaders['accept-encoding'] = 'identity'
    const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, {
      method: 'GET', headers: safeHeaders, timeout: 12_000,
      lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address: target.address, family: target.family }]) : callback(null, target.address, target.family),
    }, response => {
      let size = 0
      const chunks = []
      response.on('data', chunk => {
        size += chunk.length
        if (size > maxBytes) { response.destroy(new Error('Remote response exceeds the review byte budget.')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const headers = Object.fromEntries(Object.entries(response.headers).filter(([key, value]) => value !== undefined && !['transfer-encoding', 'connection', 'content-length'].includes(key)).map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : value]))
        resolveResult({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks) })
      })
    })
    request.on('timeout', () => request.destroy(new Error('Public resource timed out.')))
    request.on('error', reject)
    request.end()
  })
}

export function createPublicNetworkPolicy(fetchResource = publicFetch) {
  let requests = 0, bytes = 0
  return async context => {
    await context.routeWebSocket(/.*/, socket => socket.close())
    await context.route('**/*', async route => {
      const request = route.request()
      if (!['GET', 'HEAD'].includes(request.method()) || ++requests > 250 || bytes > 32 * 1024 * 1024) return route.abort('blockedbyclient')
      try {
        const result = await fetchResource(request.url(), { headers: await request.allHeaders() })
        bytes += result.body.length
        await route.fulfill(result)
      } catch { await route.abort('blockedbyclient').catch(() => {}) }
    })
  }
}
