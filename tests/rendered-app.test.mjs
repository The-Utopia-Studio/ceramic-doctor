import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewFiles } from '../src/code-review.mjs'
import { renderPreview, resolvePreview, previewConfiguration, reviewRenderedJob, PreviewPendingError } from '../src/github-app/render.mjs'
import { launchBrowser } from '../src/browser.mjs'
import { executeJob } from '../src/github-app/worker.mjs'
import { ReviewStore } from '../src/github-app/store.mjs'
import { codeMarkdown } from '../src/code-report.mjs'

const head='b'.repeat(40), base='a'.repeat(40)
const job={installation:11,repository:22,fullName:'owner/repo',kind:'pr',number:3,base,head,scope:'pr:3'}
const config={installation:11,repository:22,environment:'Preview',origins:['https://preview.example.com'],creatorIds:[7],paths:['/'],readySelector:'main h1'}
const preview={deploymentId:9,statusId:10,origin:config.origins[0],head}
const file=content=>({path:'Form.tsx',content:`export const Form=()=>(${content})`})
const labelIssues=content=>reviewFiles({files:[file(content)]}).findings.filter(f=>f.rule==='ceramic/input-label')

test('form names catch the missed input and preserve real label associations',()=>{
  for(const content of ['<input placeholder="Email" />','<textarea />','<input aria-label={null} />','<input aria-label={false} />','<label>{null}<input /></label>','<select><option>One</option></select>','<input aria-label=" " />','<input aria-labelledby="missing" />']) assert.equal(labelIssues(content).length,1,content)
  for(const content of ['<input type="hidden" />','<input aria-label="Email" />','<label>Email<input /></label>','<><label htmlFor="email">Email</label><input id="email" /></>','<><span id="label">Email</span><input aria-labelledby="label" /></>','<><label htmlFor={id}>Email</label><input id={id} /></>']) assert.equal(labelIssues(content).length,0,content)
  const unrelated=reviewFiles({files:[{path:'Forms.tsx',content:'export const A=()=> <label htmlFor="email">Email</label>; export const B=()=> <input id="email" />'}]})
  assert.ok(unrelated.findings.some(f=>f.rule==='ceramic/input-label'))
  assert.ok(reviewFiles({files:[file('<Input placeholder="Email" />')],policy:{semanticTokens:true}}).findings.some(f=>f.rule==='ceramic/input-label'))
})

test('source motion checks recognize reduced-motion guards without accepting irrelevant overrides',()=>{
  const issues=css=>reviewFiles({files:[{path:'motion.css',content:css}]}).findings.filter(f=>f.rule==='css/reduced-motion')
  assert.equal(issues('.spin { animation: spin 1s infinite }').length,1)
  assert.equal(issues('@media(prefers-reduced-motion:reduce){.spin{animation:none !important}} .spin {animation:spin 1s infinite !important}').length,1)
  assert.equal(issues('@media(prefers-reduced-motion:no-preference) or (width > 100px){.spin{animation:spin 1s infinite}}').length,1)
  assert.equal(issues('@media(prefers-reduced-motion:no-preference){ .spin { animation: spin 1s infinite } }').length,0)
  assert.equal(issues('.spin { animation: spin 1s infinite } @media(prefers-reduced-motion:reduce){.spin{animation:none}}').length,0)
  assert.equal(issues('.spin { animation: spin 1s infinite } @media(prefers-reduced-motion:reduce){.other{animation:none}}').length,1)
  assert.equal(issues('@media(prefers-reduced-motion:reduce){.spin{animation:none}} .spin { animation: spin 1s infinite }').length,1)
})

function deploymentApi({sha=head,state='success',creator=7,url=preview.origin,statusCreator=7}={}){
  return {call:async path=>path.startsWith('/deployments?')?[{id:9,sha,environment:'Preview',creator:{id:creator}}]:[{id:10,state,creator:{id:statusCreator},environment_url:url}]}
}
test('preview selection requires the exact head, latest successful status, publisher and origin',async()=>{
  assert.deepEqual(previewConfiguration(JSON.stringify([config])),[config])
  for(const bad of [{...config,origins:['https://*.example.com']},{...config,paths:['//evil.example']},{...config,creatorIds:[]}]) assert.throws(()=>previewConfiguration(JSON.stringify([bad])))
  assert.deepEqual(await resolvePreview(job,deploymentApi(),config),preview)
  await assert.rejects(resolvePreview(job,deploymentApi({sha:base}),config),PreviewPendingError)
  await assert.rejects(resolvePreview(job,deploymentApi({state:'pending'}),config),PreviewPendingError)
  await assert.rejects(resolvePreview(job,deploymentApi({creator:8}),config),PreviewPendingError)
  await assert.rejects(resolvePreview(job,deploymentApi({statusCreator:8}),config),/unauthorized/)
  await assert.rejects(resolvePreview(job,deploymentApi({url:'https://evil.example'}),config),/allowlist/)
  const noPreview=await reviewRenderedJob(job,deploymentApi(),[])
  assert.equal(noPreview.verdict,'BLOCKED')
  assert.equal(noPreview.score.value,null)
})

function html(broken, marker=head){
  return `<!doctype html><html lang="en"><head><meta name="ceramic-commit" content="${marker}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account settings</title><style>
  body { margin:0; background:white; color:black; }
  main { width:${broken?'700px':'min(700px, 100%)'}; }
  input { color:#000; background:#fff; }
  input::placeholder { color:#333; opacity:1; }
  .muted {color:${broken?'#aaa':'#333'}; font-size:16px;}
  .spinner { display:inline-block; animation:spin 1s linear infinite; }
  @keyframes spin { to {transform:rotate(360deg)} }
  ${broken?'':'@media(prefers-reduced-motion:reduce){.spinner{animation:none}}'}
  </style></head><body><main><h1>Account settings</h1>${broken?'':'<label for="email">Email address</label>'}<input id="email" type="email" placeholder="Email"><p class="muted">Your account preferences</p><span class="spinner" aria-hidden="true">Loading</span><button>Save</button></main></body></html>`
}
const renderOptions=body=>({browserLauncher:launchBrowser,validateUrl:async()=>{},contextPolicy:async context=>context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body}))})

test('real Chromium detects all four missed categories and clears the repaired scope', {timeout:90_000},async()=>{
  const before=await renderPreview(preview,config,renderOptions(html(true)))
  assert.ok(['completed','partial'].includes(before.execution))
  for(const rule of ['input-label','color-contrast','document-overflow','reduced-motion']) assert.ok(before.findings.some(f=>f.rule===rule),rule)
  assert.equal(before.verdict,'FAIL')
  assert.ok(before.findings.find(f=>f.rule==='document-overflow').evidence.some(e=>e.viewport==='mobile'))
  const after=await renderPreview(preview,config,renderOptions(html(false)))
  assert.equal(after.execution,'completed',JSON.stringify(after.coverage))
  assert.equal(after.verdict,'PASS',JSON.stringify(after.findings))
  const wrong=await renderPreview(preview,config,renderOptions(html(false,base)))
  assert.equal(wrong.verdict,'BLOCKED');assert.equal(wrong.score.value,null)
  const failed=await renderPreview(preview,config,{...renderOptions(html(false)),browserLauncher:async()=>{throw Error('Browser unavailable')}})
  assert.equal(failed.verdict,'BLOCKED')
})

test('App publication combines actual rendered failures with clean source and never approves missing rendering', {timeout:60_000},async()=>{
  for(const configured of [true,false]) {
    const store=new ReviewStore(':memory:'), calls=[]
    store.enqueue(job,'start');const claimed=store.claim()
    const api={repo:{default_branch:'main'},call:async(path,options={})=>{
      calls.push({path,...options})
      if(path==='/pulls/3')return {state:'open',head:{sha:head},base:{sha:base},changed_files:0}
      if(path.startsWith('/commits/'))return {check_runs:[]}
      if(path==='/check-runs')return {id:50}
      if(path==='/check-runs/50')return {output:{annotations_count:0}}
      if(path.startsWith('/git/trees/'))return {tree:[]}
      if(path.startsWith('/issues/3/comments'))return []
      throw Error('Unexpected API call '+path)
    }}
    try {
      await executeJob(claimed,{store,github:{installation:async()=>api},appId:99,appSlug:'doctor',
        review:async()=>reviewFiles({files:[file('<button>Save</button>')]}),
        render:configured?async()=>renderPreview(preview,config,renderOptions(html(true))):reviewRenderedJob})
      const row=store.history(11)[0], report=row.report
      assert.equal(report.sourceResult.verdict,'PASS')
      assert.equal(report.verdict,configured?'FAIL':'BLOCKED')
      const completed=calls.find(c=>c.body?.status==='completed')
      assert.equal(completed.body.conclusion,configured && report.execution==='completed'?'failure':'action_required')
      assert.match(codeMarkdown(report),/Rendered preview/)
      assert.equal(completed.body.output.annotations.length,0,'Do not invent source locations for browser findings.')
    }finally{store.close()}
  }
})

 test('render deadline also bounds DNS validation and closes the browser',async()=>{
  let closed=false
  const timed=await renderPreview(preview,config,{browserLauncher:async()=>({close:async()=>{closed=true}}),validateUrl:()=>new Promise(()=>{}),timeoutMs:20})
  assert.equal(timed.verdict,'BLOCKED');assert.match(timed.reason,/budget/);assert.equal(closed,true)
})
