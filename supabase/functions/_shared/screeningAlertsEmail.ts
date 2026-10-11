/** Stage 2: disabled-by-default, allowlisted pilot only. No public-send mode. */
type ObjectValue = Record<string, unknown>;
type Deps = {env:(name:string)=>string|undefined;fetch?:typeof fetch};
type Purpose = 'api'|'worker'|'links'|'webhook';
class Failure extends Error {
 constructor(public status:number,public code:string,message:string){super(message);}
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenPattern=/^[0-9a-f]{64}$/;
const textEncoder=new TextEncoder();
const acceptedEvents=new Set(['email.sent','email.delivered','email.bounced','email.complained','email.failed','email.suppressed','email.delivery_delayed']);
function required(d:Deps,name:string):string{
 const v=d.env(name)?.trim();if(!v)throw new Failure(503,'not_configured','Email alerts are not configured.');return v;
}
function origin(d:Deps,name:string):string{
 const u=new URL(required(d,name));
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Failure(503,'not_configured','Invalid service configuration.');
 return u.origin;
}
function fieldId(v:unknown):string{if(typeof v!=='string'||!uuid.test(v))throw new Failure(400,'invalid_request','Invalid request.');return v;}
function token(v:unknown):string{if(typeof v!=='string'||!tokenPattern.test(v))throw new Failure(400,'invalid_request','Invalid link.');return v;}
function keys(v:ObjectValue,allowed:string[]){if(Object.keys(v).some(k=>!allowed.includes(k)))throw new Failure(400,'invalid_request','Unsupported request field.');}
async function limitedText(r:Request,max=16384):Promise<string>{
 if(Number(r.headers.get('content-length')??0)>max)throw new Failure(413,'request_too_large','Request is too large.');
 const reader=r.body?.getReader();const parts:Uint8Array[]=[];let size=0;
 if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
  if(size>max){await reader.cancel();throw new Failure(413,'request_too_large','Request is too large.');}parts.push(value);
 }}finally{reader.releaseLock();}
 const buffer=new Uint8Array(size);let at=0;for(const p of parts){buffer.set(p,at);at+=p.length;}
 return new TextDecoder().decode(buffer);
}
function object(raw:string):ObjectValue{
 let v:unknown;try{v=JSON.parse(raw);}catch{throw new Failure(400,'invalid_json','Invalid JSON.');}
 if(!v||typeof v!=='object'||Array.isArray(v))throw new Failure(400,'invalid_request','Invalid request.');return v as ObjectValue;
}
function jsonType(r:Request){if(!r.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new Failure(415,'invalid_content_type','Send JSON.');}
async function remote(d:Deps,url:string,init:RequestInit):Promise<Response>{
 return (d.fetch??fetch)(url,{...init,redirect:'error',signal:AbortSignal.timeout(10000)});
}
async function rpc(d:Deps,name:string,args:ObjectValue={}):Promise<unknown>{
 const key=required(d,'SUPABASE_SERVICE_ROLE_KEY');let response:Response;
 try{response=await remote(d,`${origin(d,'SUPABASE_URL')}/rest/v1/rpc/${name}`,{method:'POST',
  headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(args)});
 }catch{throw new Failure(503,'database_unavailable','Please retry shortly.');}
 let body:ObjectValue;try{body=await response.json();}catch{throw new Failure(503,'database_unavailable','Please retry shortly.');}
 if(!response.ok){if(body.code==='54000')throw new Failure(429,'rate_limited','Please wait before requesting another verification email.');
  if(body.code==='55000')throw new Failure(409,'email_unavailable','Email alerts are currently unavailable for this address.');
  if(body.code==='23503')throw new Failure(401,'login_required','Please log in again.');
  throw new Failure(503,'database_unavailable','Please retry shortly.');}
 return body;
}
async function user(d:Deps,r:Request):Promise<string>{
 const auth=r.headers.get('authorization')??'';
 if(!/^Bearer [^\s]+$/i.test(auth)||auth.length>16384)throw new Failure(401,'login_required','Log in to manage alerts.');
 let response:Response;try{response=await remote(d,`${origin(d,'SUPABASE_URL')}/auth/v1/user`,{
  method:'GET',headers:{apikey:required(d,'SUPABASE_ANON_KEY'),Authorization:auth}});
 }catch{throw new Failure(503,'auth_unavailable','Please retry shortly.');}
 if(!response.ok)throw new Failure(401,'invalid_session','Please log in again.');
 const v=await response.json() as ObjectValue;
 if(v.is_anonymous===true||typeof v.email!=='string')throw new Failure(401,'invalid_session','A London Screenings account is required.');
 return fieldId(v.id);
}
export async function sha256(v:string):Promise<string>{
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',textEncoder.encode(v))),x=>x.toString(16).padStart(2,'0')).join('');
}
export function stableJSON(v:unknown):string{
 if(v===null||typeof v!=='object')return JSON.stringify(v);
 if(Array.isArray(v))return '['+v.map(stableJSON).join(',')+']';
 return '{'+Object.keys(v as ObjectValue).sort().map(k=>JSON.stringify(k)+':'+stableJSON((v as ObjectValue)[k])).join(',')+'}';
}
async function equal(a:string,b:string):Promise<boolean>{
 const [x,y]=await Promise.all([sha256(a),sha256(b)]);let diff=0;for(let i=0;i<x.length;i++)diff|=x.charCodeAt(i)^y.charCodeAt(i);return diff===0;
}
async function hmac(secret:string,value:string):Promise<Uint8Array>{
 const key=await crypto.subtle.importKey('raw',textEncoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return new Uint8Array(await crypto.subtle.sign('HMAC',key,textEncoder.encode(value)));
}
async function unsubscribeToken(d:Deps,id:string):Promise<string>{
 const secret=required(d,'SCREENING_ALERTS_LINK_SECRET');if(secret.length<32)throw new Failure(503,'not_configured','Invalid link configuration.');
 return Array.from(await hmac(secret,`unsubscribe:${id}`),x=>x.toString(16).padStart(2,'0')).join('');
}
function escape(v:unknown):string{return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
export function safeBooking(v:unknown):string|null{
 if(typeof v!=='string'||v.length>512)return null;
 try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
function sender(d:Deps):string{
 const v=required(d,'SCREENING_ALERTS_EMAIL_FROM');
 if(v.length>320||/[\r\n]/.test(v)||!/@/.test(v))throw new Failure(503,'not_configured','Invalid sender configuration.');return v;
}
function message(d:Deps,id:string,email:string,subject:string,html:string,text:string,headers?:ObjectValue):ObjectValue{
 return {from:sender(d),to:[email],subject,html,text,tags:[{name:'delivery_id',value:id}],...(headers?{headers}:{})};
}
async function freeze(d:Deps,id:string,payload:ObjectValue,unsub?:string,performances?:ObjectValue[]){
 return rpc(d,'screening_email_freeze',{p_id:id,p_payload:payload,p_hash:await sha256(stableJSON(payload)),
  p_unsubscribe_hash:unsub?await sha256(unsub):null,p_performances:performances??null});
}
export function digestContent(performances:ObjectValue[],date:string,unsubURL:string,appURL:string):{html:string;text:string}{
 if(performances.length>20)throw new Failure(503,'invalid_digest','Digest is too large.');
 const parts=performances.map(p=>{
  const year=typeof p.year==='number'?` (${p.year})`:'';
  const when=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',dateStyle:'medium',timeStyle:'short'}).format(new Date(String(p.start_time)));
  const label=`${String(p.title).slice(0,160)}${year} — ${String(p.cinema).slice(0,100)} — ${when} (London time)`;
  const link=safeBooking(p.booking_url);
  return {html:`<li>${escape(label)}${link?` — <a href="${escape(link)}">Book</a>`:''}</li>`,text:label+(link?`\n${link}`:'')};
 });
 return {html:`<h1>New London screenings</h1><p>${escape(date)}</p><ul>${parts.map(p=>p.html).join('')}</ul><p><a href="${escape(appURL)}">London Screenings</a> · <a href="${escape(unsubURL)}">Unsubscribe</a></p>`,
  text:`New London screenings — ${date}\n\n${parts.map(p=>p.text).join('\n\n')}\n\nLondon Screenings: ${appURL}\nUnsubscribe: ${unsubURL}`};
}
async function renderDrafts(d:Deps,stopAt:number):Promise<number>{
 const drafts=await rpc(d,'screening_email_drafts') as ObjectValue[];let count=0;
 for(const draft of drafts){if(Date.now()+12000>=stopAt)break;const id=fieldId(draft.id),unsub=await unsubscribeToken(d,id);
  const url=`${origin(d,'SUPABASE_URL')}/functions/v1/screening-alerts-email-links?delivery=${id}&token=${unsub}`;
  const content=digestContent((draft.performances??[]) as ObjectValue[],String(draft.collection_date),url,origin(d,'SCREENING_ALERTS_APP_URL'));
  const result=await freeze(d,id,message(d,id,String(draft.email),'New London screenings for your followed films',content.html,content.text,
   {'List-Unsubscribe':`<${url}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}),unsub,(draft.performances??[]) as ObjectValue[]) as ObjectValue;
  if(result.frozen===true)count++;
 }return count;
}
export function providerResult(status:number,body:ObjectValue):'accepted'|'retry'|'failed'|'quarantined'{
 if(status>=200&&status<300)return typeof body.id==='string'&&uuid.test(body.id)?'accepted':'retry';
 if(status===409)return body.name==='concurrent_idempotent_requests'?'retry':'quarantined';
 if(status===429||status>=500)return 'retry';return 'failed';
}
async function sendDue(d:Deps,stopAt:number):Promise<ObjectValue>{
 // This gate runs before claiming budget or contacting Resend. Unknown modes fail closed.
 if(d.env('SCREENING_ALERTS_EMAIL_MODE')!=='pilot')return {provider_requests:0,public_sending_enabled:false};
 const key=required(d,'RESEND_API_KEY');required(d,'RESEND_WEBHOOK_SECRET');
 const ids=await rpc(d,'screening_email_due') as string[];let requests=0,accepted=0,lastStarted=0;
 for(const id of ids){if(Date.now()+35000>=stopAt)break;const delay=1000-(Date.now()-lastStarted);if(delay>0)await new Promise(r=>setTimeout(r,delay));
  const claim=await rpc(d,'screening_email_claim',{p_id:fieldId(id)}) as ObjectValue;
  if(claim.claimed!==true)continue;
  const args:ObjectValue={p_id:id,p_lease:fieldId(claim.lease)};
  const body=stableJSON(claim.payload);
  if(!await equal(await sha256(body),String(claim.payload_hash))){
   await rpc(d,'screening_email_finish',{...args,p_result:'quarantined',p_code:'payload_hash_mismatch'});continue;
  }
  let result:'accepted'|'retry'|'failed'|'quarantined'='retry';let responseBody:ObjectValue={};let code='network_uncertain',retryAfter:number|null=null;
  lastStarted=Date.now();
  requests++;
  try{const response=await remote(d,'https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,
   'Content-Type':'application/json','Idempotency-Key':String(claim.idempotency_key)},body});
   try{responseBody=await response.json() as ObjectValue;}catch{responseBody={};}
   const retry=response.headers.get('retry-after');
   if(retry){const seconds=/^\d+$/.test(retry)?Number(retry):Math.ceil((Date.parse(retry)-Date.now())/1000);
    if(Number.isFinite(seconds)&&seconds>=0)retryAfter=Math.min(86400,seconds);}
   result=providerResult(response.status,responseBody);code=`http_${response.status}_${String(responseBody.name??'').slice(0,60)}`;
  }catch{/* Acceptance can be unknown. Keep the original key and bytes. */}
  await rpc(d,'screening_email_finish',{...args,p_result:result,p_provider_id:result==='accepted'?responseBody.id:null,p_code:code,p_retry_after:retryAfter});
  if(result==='accepted')accepted++;
 }return {provider_requests:requests,accepted_responses:accepted,public_sending_enabled:false};
}
async function api(d:Deps,r:Request,body:ObjectValue):Promise<unknown>{
 const id=await user(d,r);keys(body,['action','consent']);
 if(!['status','request_verification','disable'].includes(String(body.action)))throw new Failure(400,'invalid_action','Unsupported action.');
 if(body.action!=='request_verification'&&body.consent!==undefined)throw new Failure(400,'invalid_request','Unsupported request field.');
 const budget=await rpc(d,'screening_email_budget',{p_user_id:id}) as ObjectValue;
 if(budget.allowed!==true)throw new Failure(429,'rate_limited','Too many requests. Please retry shortly.');
 if(body.action==='status')return rpc(d,'screening_email_status',{p_user_id:id});
 if(body.action==='disable')return rpc(d,'screening_email_request',{p_user_id:id,p_action:'disable'});
 if(body.consent!==true)throw new Failure(400,'consent_required','Explicit permission is required.');
 if(d.env('SCREENING_ALERTS_EMAIL_MODE')!=='pilot')throw new Failure(409,'email_disabled','Email delivery is currently disabled.');
 // No random token is returned to the browser. Only the intended mailbox receives it.
 const random=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
 const pending=await rpc(d,'screening_email_request',{p_user_id:id,p_action:'request_verification',p_token_hash:await sha256(random),p_consent:true}) as ObjectValue;
 if(!pending.delivery_id)return pending;
 const delivery=fieldId(pending.delivery_id),challenge=fieldId(pending.challenge_id);
 const url=`${origin(d,'SCREENING_ALERTS_APP_URL')}/screening-alerts-email.html#purpose=confirm&challenge=${challenge}&token=${random}`;
 const frozen=await freeze(d,delivery,message(d,delivery,String(pending.email),'Confirm your London Screenings alerts',
  `<h1>Confirm screening alerts</h1><p>You requested morning screening emails for films you follow.</p><p><a href="${escape(url)}">Review and confirm</a></p><p>This link expires in 24 hours. If you did not request it, ignore this email.</p>`,
  `Confirm screening alerts\n\nYou requested morning screening emails for films you follow. Review and confirm: ${url}\n\nThis link expires in 24 hours. If you did not request it, ignore this email.`)) as ObjectValue;
 if(frozen.frozen!==true)throw new Failure(409,'request_changed','Your preferences changed. Please retry.');
 return {verification_queued:true,public_sending_enabled:false};
}
async function links(d:Deps,r:Request):Promise<unknown>{
 const url=new URL(r.url);
 if(r.headers.get('content-type')?.toLowerCase().startsWith('application/json')){
  const body=object(await limitedText(r));keys(body,body.action==='confirm'?['action','challenge','token']:['action','delivery','token']);
  if(body.action==='confirm')return rpc(d,'screening_email_confirm',{p_challenge_id:fieldId(body.challenge),p_token_hash:await sha256(token(body.token))});
  if(body.action==='unsubscribe')return rpc(d,'screening_email_unsubscribe',{p_delivery_id:fieldId(body.delivery),p_token_hash:await sha256(token(body.token))});
  throw new Failure(400,'invalid_action','Invalid link.');
 }
 const contentType=r.headers.get('content-type')??'';let value:unknown;
 if(contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')){
  const form=new URLSearchParams(await limitedText(r));if([...form.keys()].length!==1)throw new Failure(400,'invalid_request','Invalid unsubscribe request.');
  value=form.get('List-Unsubscribe');
 }else if(contentType.toLowerCase().startsWith('multipart/form-data')){
  const raw=await limitedText(r);const form=await new Response(raw,{headers:{'Content-Type':contentType}}).formData();
  if([...form.keys()].length!==1)throw new Failure(400,'invalid_request','Invalid unsubscribe request.');value=form.get('List-Unsubscribe');
 }else throw new Failure(415,'invalid_content_type','Invalid unsubscribe request.');
 if(value!=='One-Click')throw new Failure(400,'invalid_request','Invalid unsubscribe request.');
 return rpc(d,'screening_email_unsubscribe',{p_delivery_id:fieldId(url.searchParams.get('delivery')),p_token_hash:await sha256(token(url.searchParams.get('token')))});
}
export async function verifyWebhook(raw:string,headers:Headers,secret:string,now=Date.now()):Promise<void>{
 const id=headers.get('svix-id')??'',ts=headers.get('svix-timestamp')??'',signatures=headers.get('svix-signature')??'';
 if(!id||id.length>200||!/^\d{1,12}$/.test(ts)||Math.abs(now/1000-Number(ts))>300||signatures.length>2048||!secret.startsWith('whsec_'))
  throw new Failure(401,'invalid_signature','Invalid webhook.');
 let bytes:Uint8Array<ArrayBuffer>;try{bytes=Uint8Array.from(atob(secret.slice(6)),c=>c.charCodeAt(0));}catch{throw new Failure(503,'not_configured','Invalid webhook configuration.');}
 const key=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=new Uint8Array(await crypto.subtle.sign('HMAC',key,textEncoder.encode(`${id}.${ts}.${raw}`)));
 const expected=btoa(String.fromCharCode(...signature));
 for(const part of signatures.split(' ')){const [version,v]=part.split(',');if(version==='v1'&&v&&await equal(v,expected))return;}
 throw new Failure(401,'invalid_signature','Invalid webhook.');
}
async function webhook(d:Deps,r:Request):Promise<unknown>{
 const raw=await limitedText(r,65536);await verifyWebhook(raw,r.headers,required(d,'RESEND_WEBHOOK_SECRET'));
 const event=object(raw);if(!acceptedEvents.has(String(event.type)))return {received:true,ignored:true};
 const data=event.data as ObjectValue;if(!data||typeof data!=='object')throw new Failure(400,'invalid_event','Invalid webhook.');
 const tags=data.tags;let tagged:unknown;
 if(Array.isArray(tags))tagged=tags.find(t=>t?.name==='delivery_id')?.value;
 else if(tags&&typeof tags==='object')tagged=(tags as ObjectValue).delivery_id;
 const at=String(event.created_at);if(!Number.isFinite(Date.parse(at)))throw new Failure(400,'invalid_event','Invalid webhook.');
 return rpc(d,'screening_email_event',{p_event_id:r.headers.get('svix-id'),p_delivery_id:tagged===undefined?null:fieldId(tagged),
  p_provider_id:fieldId(data.email_id),p_type:event.type,p_at:at});
}
export function createEmailHandler(purpose:Purpose,d:Deps){return async(r:Request):Promise<Response>=>{
 const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Vary':'Origin'};
 try{
  const suppliedOrigin=r.headers.get('origin');
  if((purpose==='api'||purpose==='links')&&suppliedOrigin){if(suppliedOrigin!==origin(d,'SCREENING_ALERTS_APP_URL'))throw new Failure(403,'origin_denied','Origin is not allowed.');
   headers['Access-Control-Allow-Origin']=suppliedOrigin;headers['Access-Control-Allow-Headers']='authorization,apikey,content-type,x-client-info';
   headers['Access-Control-Allow-Methods']='POST,OPTIONS';}
  if(r.method==='OPTIONS'&&(purpose==='api'||purpose==='links'))return new Response(null,{status:204,headers});
  if(r.method==='GET'&&purpose==='links'){
   const url=new URL(r.url);const id=fieldId(url.searchParams.get('delivery')),t=token(url.searchParams.get('token'));
   // GET never activates or unsubscribes; scanners only open a review page.
   return new Response(null,{status:303,headers:{...headers,Location:`${origin(d,'SCREENING_ALERTS_APP_URL')}/screening-alerts-email.html#purpose=unsubscribe&delivery=${id}&token=${t}`}});
  }
  if(r.method!=='POST')throw new Failure(405,'method_not_allowed','Use POST.');
  let result:unknown;
  if(purpose==='worker'){
   const secret=required(d,'SCREENING_ALERTS_WORKER_SECRET'),provided=r.headers.get('x-screening-alerts-worker-secret')??'';
   if(secret.length<32||secret.length>512)throw new Failure(503,'not_configured','Invalid worker configuration.');
   if(provided.length>512||!await equal(secret,provided))throw new Failure(401,'worker_auth_required','Worker authentication required.');
   jsonType(r);const body=object(await limitedText(r));keys(body,['action']);
   if(body.action==='report')result=await rpc(d,'screening_email_report');
   else if(body.action==='process'){
    if(d.env('SCREENING_ALERTS_EMAIL_MODE')!=='pilot')result={provider_requests:0,public_sending_enabled:false,report:await rpc(d,'screening_email_report')};
    else{const report=await rpc(d,'screening_email_report') as ObjectValue;
     if(report.mode!=='pilot')result={provider_requests:0,public_sending_enabled:false,report};
     else{const stopAt=Date.now()+90000;await rpc(d,'screening_email_maintenance');await rpc(d,'screening_email_prepare');
      await renderDrafts(d,stopAt);result=await sendDue(d,stopAt);}}
   }else throw new Failure(400,'invalid_action','Use report or process.');
  }else if(purpose==='webhook')result=await webhook(d,r);
  else if(purpose==='links')result=await links(d,r);
  else{jsonType(r);result=await api(d,r,object(await limitedText(r)));}
  return new Response(JSON.stringify(result),{status:200,headers});
 }catch(e){const error=e instanceof Failure?e:new Failure(503,'service_unavailable','Email alerts are temporarily unavailable.');
  if(error.status===429)headers['Retry-After']='600';
  return new Response(JSON.stringify({error:error.message,code:error.code,public_sending_enabled:false}),{status:error.status,headers});}
};}
