import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
let createStage1Handler;
const A='11111111-1111-4111-8111-111111111111';
const secret='a'.repeat(48), service='SERVER-ONLY-SECRET';
const values={SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'publishable-test',SUPABASE_SERVICE_ROLE_KEY:service,
 SCREENING_ALERTS_APP_URL:'https://app.example',TMDB_READ_ACCESS_TOKEN:'TMDB-PRIVATE',SCREENING_ALERTS_WORKER_SECRET:secret};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function setup(overrides={},envChanges={}) {
 const calls=[];
 const fetcher=async(url,init={})=>{
  calls.push({url,init,body:init.body?JSON.parse(init.body):undefined});
  if(url.endsWith('/auth/v1/user'))return overrides.auth??json({id:A,email:'person@example.com'});
  if(url.endsWith('/rpc/screening_alerts_budget'))return json(overrides.budget??{allowed:true});
  if(url.includes('/search/movie'))return json(overrides.search??{results:[{id:348,title:'Alien',release_date:'1979-05-25'}]});
  if(url.includes('/movie/'))return overrides.movie??json({id:348,title:'Alien',release_date:'1979-05-25',poster_path:'/poster.jpg'});
  if(url.endsWith('/rpc/screening_alerts_request'))return overrides.request??json({stage:1,sending_enabled:false});
  if(url.includes('/rpc/'))return json({stage:1,sending_enabled:false,emails_sent:0});
  throw new Error('Unexpected external request');
 };
 const env=name=>({...values,...envChanges})[name];
 return {calls,api:createStage1Handler('api',{env,fetch:fetcher}),worker:createStage1Handler('worker',{env,fetch:fetcher})};
}
const req=(body,headers={},method='POST')=>new Request('https://edge.example',{method,headers:{'Content-Type':'application/json',Authorization:'Bearer session-test',...headers},body:method==='POST'?JSON.stringify(body):undefined});
before(async()=>{
 const b=await build({entryPoints:['supabase/functions/_shared/screeningAlertsStage1.ts'],bundle:true,format:'esm',write:false,platform:'neutral'});
 ({createStage1Handler}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64')));
});
test('follow validates JWT and authoritative TMDB identity; no client metadata is accepted',async()=>{
 const s=setup();const res=await s.api(req({action:'follow',tmdbId:348}));assert.equal(res.status,200);
 const write=s.calls.find(x=>x.url.endsWith('/rpc/screening_alerts_request'));
 assert.deepEqual(write.body,{p_user_id:A,p_action:'follow',p_tmdb_id:348,p_title:'Alien',p_year:1979,p_poster:'/poster.jpg'});
 assert.equal(write.init.headers.Authorization,`Bearer ${service}`);
 assert(!s.calls.some(x=>/resend/.test(x.url)));
});
test('identity and metadata spoofing rejected before any write',async()=>{
 const s=setup();for(const extra of [{userId:'victim'},{title:'Wrong film'},{email:'victim@example.com'}]) {
  assert.equal((await s.api(req({action:'follow',tmdbId:348,...extra}))).status,400);
 }
 assert(!s.calls.some(x=>x.url.includes('/movie/')||x.url.endsWith('screening_alerts_request')));
});
test('missing JWT, invalid JWT and anonymous users cannot follow',async()=>{
 let s=setup();assert.equal((await s.api(req({action:'read'},{Authorization:''}))).status,401);assert.equal(s.calls.length,0);
 s=setup({auth:json({},401)});assert.equal((await s.api(req({action:'follow',tmdbId:348}))).status,401);
 s=setup({auth:json({id:A,email:'person@example.com',is_anonymous:true})});assert.equal((await s.api(req({action:'read'}))).status,401);
});
test('email confirmation status never grants sending permission in Stage 1',async()=>{
 const s=setup({auth:json({id:A,email:'person@example.com',email_confirmed_at:'2020-01-01'})});
 assert.equal((await (await s.api(req({action:'read'}))).json()).sending_enabled,false);
});
test('search returns choices and does not save first result',async()=>{
 const s=setup({search:{results:[null,{id:348,title:'Alien',release_date:'1979-05-25'},{id:999,title:'Alien',release_date:'2000-01-01'}]}});
 const res=await s.api(req({action:'search',query:'Alien'}));assert.equal(res.status,200);
 const body=await res.json();assert.equal(body.candidates.length,2);
 assert(!s.calls.some(x=>x.url.endsWith('screening_alerts_request')));
});
test('TMDB missing or mismatched film never reaches subscription write',async()=>{
 for(const movie of [json({},404),json({id:999,title:'Wrong version'})]) {
  const s=setup({movie});assert.notEqual((await s.api(req({action:'follow',tmdbId:348}))).status,200);
  assert(!s.calls.some(x=>x.url.endsWith('screening_alerts_request')));
 }
});
test('invalid IDs and malformed searches fail',async()=>{
 const s=setup();for(const id of [0,-1,1.5,'348',Number.MAX_SAFE_INTEGER+1]) assert.equal((await s.api(req({action:'follow',tmdbId:id}))).status,400);
 for(const query of ['a','x'.repeat(201),null]) assert.equal((await s.api(req({action:'search',query}))).status,400);
});
test('rate limit is durable RPC gate and returns retry header before TMDB',async()=>{
 const s=setup({budget:{allowed:false,retry_after:12}});const res=await s.api(req({action:'search',query:'Alien'}));
 assert.equal(res.status,429);assert.equal(res.headers.get('Retry-After'),'12');assert(!s.calls.some(x=>x.url.includes('themoviedb')));
});
test('remove, pause and resume stay user scoped and require no TMDB lookup',async()=>{
 const s=setup();for(const body of [{action:'remove',tmdbId:348},{action:'pause'},{action:'resume'}])assert.equal((await s.api(req(body))).status,200);
 assert(s.calls.filter(x=>x.url.endsWith('screening_alerts_request')).every(x=>x.body.p_user_id===A));
 assert(!s.calls.some(x=>x.url.includes('themoviedb')));
});
test('allowed-origin preflight works and foreign-origin requests are rejected',async()=>{
 const s=setup();const pre=await s.api(req({}, {Origin:'https://app.example'},'OPTIONS'));
 assert.equal(pre.status,204);assert.equal(pre.headers.get('Access-Control-Allow-Origin'),'https://app.example');
 assert.equal((await s.api(req({action:'read'},{Origin:'https://evil.example'}))).status,403);assert.equal(s.calls.length,0);
});
test('worker requires a separate strong secret; a public key/JWT is insufficient',async()=>{
 const s=setup();for(const supplied of ['', 'publishable-test','Bearer session-test'])assert.equal((await s.worker(req({action:'detect'},{'x-screening-alerts-worker-secret':supplied}))).status,401);
 assert.equal(s.calls.length,0);
 const bad=setup({}, {SCREENING_ALERTS_WORKER_SECRET:'short'});assert.equal((await bad.worker(req({action:'detect'}))).status,503);
});
test('authenticated worker detects/reports only; user-provided clocks and sending are rejected',async()=>{
 const s=setup();const headers={'x-screening-alerts-worker-secret':secret};
 assert.equal((await s.worker(req({action:'detect',batchSize:10},headers))).status,200);
 assert.deepEqual(s.calls[0].body,{p_batch_size:10});assert.equal((await s.worker(req({action:'report'},headers))).status,200);
 for(const body of [{action:'send'},{action:'seed'},{action:'detect',now:'2000-01-01'},{action:'detect',batchSize:1001}])assert.equal((await s.worker(req(body,headers))).status,400);
});
test('oversize, malformed and non-JSON request bodies are rejected',async()=>{
 const s=setup();assert.equal((await s.api(req({action:'search',query:'x'.repeat(17000)}))).status,413);
 assert.equal((await s.api(new Request('https://edge.example',{method:'POST',headers:{'Content-Type':'application/json'},body:'{oops'}))).status,400);
 assert.equal((await s.api(req({action:'read'},{'Content-Type':'text/plain'}))).status,415);
});
test('method restrictions and database errors never expose credentials',async()=>{
 const s=setup({request:json({code:'P0001',message:service},500)});
 assert.equal((await s.api(req({}, {},'GET'))).status,405);
 const res=await s.api(req({action:'follow',tmdbId:348}));assert.equal(res.status,503);assert(!((await res.text()).includes(service)));
});
test('baseline missing and follow limit have specific friendly responses',async()=>{
 for(const [code,status,expected] of [['55000',503,'baseline_required'],['54000',409,'follow_limit']]) {
  const s=setup({request:json({code},400)});const res=await s.api(req({action:'follow',tmdbId:348}));
  assert.equal(res.status,status);assert.equal((await res.json()).code,expected);
 }
});
