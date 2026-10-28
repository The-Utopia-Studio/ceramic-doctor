import { createRemoteStore } from '../src/remote-store.mjs'
export default async function handler(request, response) {
  if (!process.env.CRON_SECRET || request.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return response.status(403).end()
  response.status(200).json(await createRemoteStore().cleanup())
}
