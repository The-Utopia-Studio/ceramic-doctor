export default function handler(_request, response) {
  response.setHeader('Cache-Control', 'no-store')
  response.status(200).json({ name: 'ceramic-doctor', version: '0.3.0', transport: 'streamable-http', endpoint: '/mcp', authentication: 'anonymous', reviewScope: ['submitted UI source', 'public HTTP(S)'], documentation: 'https://github.com/The-Utopia-Studio/ceramic-doctor' })
}
