import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, createVerify } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifySignature, reviewEvent } from '../src/github-app/events.mjs'
import { ReviewStore } from '../src/github-app/store.mjs'
import { createAppHandler, startApp } from '../src/github-app/server.mjs'
import { appJwt, createGithub, GithubError, collectSource } from '../src/github-app/github.mjs'
import { executeJob } from '../src/github-app/worker.mjs'

const base = 'a'.repeat(40), head = 'b'.repeat(40), sha = 'c'.repeat(40)
const job = { installation: 11, repository: 22, fullName: 'owner/repo', kind: 'pr', number: 3, base, head, scope: 'pr:3' }
const payload = { installation: { id: 11 }, repository: { id: 22, full_name: 'owner/repo', default_branch: 'trunk' }, action: 'opened', pull_request: { number: 3, head: { sha: head }, base: { sha: base, repo: { id: 22 } } } }
const secret = 'x'.repeat(32)
const sign = body => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
const pr = { state: 'open', head: { sha: head }, base: { sha: base }, changed_files: 1 }
function fakeApi({ source = 'export const Card=()=> <img src="x" />', stale = false, error, empty = false, filename = 'Card.tsx' } = {}) {
  const calls = []; let comment = null, check = { id: 50, output: { annotations_count: 0 } }
  const api = { repo: { id: 22, default_branch: 'trunk' }, async call(path, options = {}) {
    calls.push({ path, ...options })
    if (error) throw error
    if (path === '') return api.repo
    if (path === '/pulls/3') return { ...pr, changed_files: empty ? 0 : 1, ...(stale ? { head: { sha: base } } : {}) }
    if (path.startsWith('/commits/')) return { check_runs: [] }
    if (path === '/check-runs' && options.method === 'POST') return check
    if (path === '/check-runs/50') { if (options.method === 'PATCH') { check = { ...check, ...options.body }; return check } return check }
    if (path.startsWith('/pulls/3/files')) return [{ filename, status: 'modified', sha, patch: '@@ -1 +1 @@\n-old\n+new' }]
    if (path === `/git/trees/${base}`) return { tree: [] }
    if (path === `/git/trees/${head}`) return { tree: [{ path: filename, type: 'blob', mode: '100644', sha }] }
    if (path === `/git/blobs/${sha}`) return { encoding: 'base64', size: Buffer.byteLength(source), content: Buffer.from(source).toString('base64') }
    if (path.startsWith('/issues/3/comments') && !options.method) return comment ? [comment] : []
    if (path === '/issues/3/comments' && options.method === 'POST') { comment = { id: 60, body: options.body.body, user: { login: 'doctor[bot]' } }; return comment }
    if (path === '/issues/comments/60') { comment.body = options.body.body; return comment }
    throw Error('Unexpected mock path: ' + path)
  } }
  return { api, calls, github: { async installation() { return api } } }
}
async function execute(options = {}) {
  const store = new ReviewStore(':memory:'); const mock = fakeApi(options)
  store.enqueue(job,'delivery'); const claimed = store.claim()
  await executeJob(claimed, { store, github: mock.github, appId: 99, appSlug: 'doctor' })
  return { store, claimed, ...mock }
}

test('webhook signature verifies exact bytes and rejects malformed signatures', () => {
  const body = Buffer.from(JSON.stringify(payload))
  assert.equal(verifySignature(body, sign(body), secret), true)
  for (const signature of [undefined, 'sha256=x', 'sha256='+'0'.repeat(64)]) assert.equal(verifySignature(body, signature, secret), false)
  assert.equal(verifySignature(Buffer.concat([body,Buffer.from(' ')]), sign(body), secret), false)
  assert.deepEqual(reviewEvent('pull_request',payload),job)
  assert.equal(reviewEvent('push',{ ...payload, deleted:true }),null)
  assert.throws(()=>reviewEvent('pull_request',{...payload,repository:{...payload.repository,full_name:'https://evil.test/repo'}}))
})

test('JWT and installation tokens are short-lived and scoped to one repository', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa',{modulusLength:2048})
  const jwt = appJwt(99,privateKey,1000_000), parts = jwt.split('.')
  const claims = JSON.parse(Buffer.from(parts[1],'base64url'))
  assert.equal(claims.iss,'99'); assert.equal(claims.exp-claims.iat,600)
  assert.equal(createVerify('RSA-SHA256').update(parts.slice(0,2).join('.')).verify(publicKey,parts[2],'base64url'),true)
  const calls=[]
  const github=createGithub({appId:99,privateKey,fetchImpl:async(url,options)=>{
    calls.push({url,...options}); return Response.json(url.includes('access_tokens')?{token:'installation-test-token'}:{id:22})
  }})
  await github.installation(job)
  assert.deepEqual(JSON.parse(calls[0].body),{repository_ids:[22],permissions:{contents:'read',checks:'write',pull_requests:'write'}})
  assert.equal(calls[1].headers.Authorization,'Bearer installation-test-token')
  assert.ok(calls.every(c=>c.url.startsWith('https://api.github.com/')&&c.redirect==='error'))
})

test('durable queue deduplicates restarts, fences expired leases and keeps tenant history isolated', async () => {
  const dir=await mkdtemp(join(tmpdir(),'doctor-app-')); let time=Date.now(), store
  try {
    const path=join(dir,'jobs.sqlite'); store=new ReviewStore(path,{now:()=>time,monthlyLimit:1})
    const first=store.enqueue(job,'one'); assert.equal(store.enqueue(job,'one').duplicate,true)
    const claimed=store.claim(); assert.equal(store.quotaExceeded(claimed),false)
    store.close(); store=new ReviewStore(path,{now:()=>time,monthlyLimit:1})
    assert.equal(store.enqueue(job,'changed-delivery-header').duplicate,true)
    assert.equal(store.claim(),null)
    time+=180001; const recovery=store.claim()
    assert.equal(recovery.id,first.id); assert.equal(recovery.attempts,2); assert.equal(store.active(claimed),false)
    assert.equal(store.quotaExceeded(recovery),true)
    store.finish(claimed,'completed',{report:{verdict:'PASS'}})
    assert.equal(store.history(11)[0].state,'running')
    store.finish(recovery,'blocked',{error:'budget'})
    const rerun=store.enqueue(store.find(first.id,11,22),'rerun',{rerun:true})
    assert.notEqual(rerun.id,first.id); assert.equal(store.claim().id,rerun.id)
    assert.equal(store.history(12).length,0)
    assert.equal(store.find(first.id,12,22),null)
    const nextMonth=new Date(time); nextMonth.setUTCMonth(nextMonth.getUTCMonth()+1,1); nextMonth.setUTCHours(0,0,0,0); time=nextMonth.getTime()
    assert.equal(store.quotaExceeded(store.claim()),false, 'recovered work counts in the month of execution')
    store.transaction(()=>store.revoke(11,22))
    assert.equal(store.history(11).length,0); assert.equal(store.enqueue(job,'after-removal').revoked,true)
  } finally { store?.close(); await rm(dir,{recursive:true,force:true}) }
})

test('HTTP webhook intake persists authorized jobs, rejects spoofing and handles uninstall without resurrection', async () => {
  const store=new ReviewStore(':memory:')
  const server=createServer(createAppHandler({store,webhookSecret:secret,operatorToken:secret,allowedInstallations:new Set([11]),appId:99}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url=`http://127.0.0.1:${server.address().port}`
  const send=(event,data,valid=true)=>{const body=JSON.stringify(data);return fetch(url+'/webhooks/github',{method:'POST',headers:{'x-github-event':event,'x-hub-signature-256':valid?sign(body):'bad'},body})}
  try {
    assert.equal((await send('pull_request',payload,false)).status,401)
    assert.equal((await send('pull_request',{...payload,installation:{id:12}})).status,403)
    assert.equal((await send('pull_request',payload)).status,202)
    assert.equal((await (await send('pull_request',payload)).json()).duplicate,true)
    assert.equal(store.history(11).length,1)
    assert.equal((await fetch(url+'/api/installations/11/reviews')).status,401)
    assert.equal((await fetch(url+'/api/installations/12/reviews',{headers:{authorization:`Bearer ${secret}`}})).status,404)
    assert.equal((await send('installation',{installation:{id:11},action:'deleted'})).status,202)
    assert.equal(store.history(11).length,0)
    await send('installation',{installation:{id:11},action:'created'})
    assert.equal(store.blocked(11,22),true)
  } finally { await new Promise(resolve=>server.close(resolve)); store.close() }
  await assert.rejects(startApp({}),/Configure App/)
})

test('real review engine publishes a failure and idempotent PR summary without executing source', async () => {
  const result=await execute()
  try {
    const row=result.store.history(11)[0]
    assert.equal(row.state,'completed'); assert.equal(row.report.verdict,'FAIL')
    assert.equal(row.report.context.head,head); assert.equal(row.report.context.policyRevision,base)
    const publication=result.calls.find(c=>c.path==='/check-runs/50'&&c.body?.conclusion==='failure')
    assert.equal(publication.body.output.annotations[0].path,'Card.tsx')
    assert.ok(result.calls.some(c=>c.path==='/issues/3/comments'&&c.method==='POST'))
    result.store.enqueue(job,'rerequest',{rerun:true})
    await executeJob(result.store.claim(),{store:result.store,github:result.github,appId:99,appSlug:'doctor'})
    assert.equal(result.calls.filter(c=>c.path==='/issues/3/comments'&&c.method==='POST').length,1)
    assert.ok(result.calls.some(c=>c.path==='/issues/comments/60'&&c.method==='PATCH'))
  }finally{result.store.close()}
})

test('repairs pass, non-UI changes stay neutral, stale work cancels, and transient errors retry', async () => {
  for(const [options,expected] of [[{source:'export const Card=()=> <img src="x" alt="Logo" />'},'PASS'],[{empty:true},'SKIP']]){
    const r=await execute(options); try{assert.equal(r.store.history(11)[0].report.verdict,expected)}finally{r.store.close()}
  }
  const stale=await execute({stale:true});try{assert.equal(stale.store.history(11)[0].state,'cancelled');assert.ok(!stale.calls.some(c=>c.method==='POST'))}finally{stale.store.close()}
  const retry=await execute({error:new GithubError(429,60_000)});try{assert.equal(retry.store.history(11)[0].state,'queued');assert.equal(retry.store.claim(),null)}finally{retry.store.close()}
})

test('coverage truncation, missing patches, and unavailable policy do not produce approval', async () => {
  const {api}=fakeApi()
  await assert.rejects(collectSource(job,api,{...pr,changed_files:301}),/coverage/)
  const missing={...api,call:async(path,...args)=>path.startsWith('/pulls/3/files')?[{filename:'Card.tsx',sha,status:'modified'}]:api.call(path,...args)}
  await assert.rejects(collectSource(job,missing,pr),/diff is missing/)
  const policy={...api,call:async(path,...args)=>path===`/git/trees/${base}`?{tree:[{path:'.ceramic-review.json',type:'blob',mode:'120000',sha}]}:api.call(path,...args)}
  await assert.rejects(collectSource(job,policy,pr),/Invalid base policy/)
  const symlink={...api,call:async(path,...args)=>path===`/git/trees/${head}`?{tree:[{path:'Card.tsx',type:'blob',mode:'120000',sha}]}:api.call(path,...args)}
  await assert.rejects(collectSource(job,symlink,pr),/symlink/)
  const r=await execute({source:'<template />',filename:'Card.vue'})
  try { assert.notEqual(r.store.history(11)[0].report?.verdict,'PASS') } finally { r.store.close() }
})
