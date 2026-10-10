/** Stage 1: authenticated requests + bounded detection. No email transport. */
export type Environment = (name: string) => string | undefined;
type JsonObject = Record<string, unknown>;
type Dependencies = { env: Environment; fetch?: typeof fetch };
class HttpError extends Error {
  constructor(public status: number, message: string, public code: string, public retryAfter?: number) { super(message); }
}
const actions = new Set(['read', 'search', 'follow', 'remove', 'pause', 'resume']);
const tmdbBase = 'https://api.themoviedb.org/3';

function required(env: Environment, name: string): string {
  const value = env(name)?.trim();
  if (!value) throw new HttpError(503, 'Screening Alerts is not configured.', 'not_configured');
  return value;
}
function projectUrl(env: Environment): string {
  const u = new URL(required(env, 'SUPABASE_URL'));
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname)))) {
    throw new HttpError(503, 'Screening Alerts is not configured.', 'not_configured');
  }
  return u.origin;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, 'Select a valid film or batch size.', 'invalid_number');
  }
  return value;
}
function keys(body: JsonObject, allowed: string[]) {
  if (Object.keys(body).some(k => !allowed.includes(k))) throw new HttpError(400, 'Unsupported request field.', 'invalid_request');
}
async function readBody(request: Request): Promise<JsonObject> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Send a JSON request.', 'invalid_content_type');
  }
  const max = 16384;
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > max) throw new HttpError(413, 'Request is too large.', 'request_too_large');
  const reader = request.body?.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > max) { await reader.cancel(); throw new HttpError(413, 'Request is too large.', 'request_too_large'); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part,offset); offset += part.length; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'Invalid JSON request.', 'invalid_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Invalid request.', 'invalid_request');
  return parsed as JsonObject;
}
async function external(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try { return await fetcher(url, {...init, signal: AbortSignal.timeout(10000)}); }
  catch { throw new HttpError(503, 'The service could not be reached. Please retry.', 'service_unavailable'); }
}
async function rpc(deps: Dependencies, name: string, body: JsonObject): Promise<unknown> {
  const key = required(deps.env,'SUPABASE_SERVICE_ROLE_KEY');
  const res = await external(deps.fetch ?? fetch, `${projectUrl(deps.env)}/rest/v1/rpc/${name}`, {
    method:'POST',headers:{'Content-Type':'application/json',apikey:key,Authorization:`Bearer ${key}`},body:JSON.stringify(body),
  });
  let value: unknown; try { value = await res.json(); } catch { throw new HttpError(503,'Invalid service response.','invalid_response'); }
  if (!res.ok) {
    const code = (value as JsonObject)?.code;
    if (code === '55000') throw new HttpError(503,'Screening Alerts has not been initialised.','baseline_required');
    if (code === '54000') throw new HttpError(409,'The film-follow limit has been reached.','follow_limit');
    if (code === '23503') throw new HttpError(401,'Please log in again.','account_unavailable');
    throw new HttpError(503,'Screening Alerts could not complete this request.','database_unavailable');
  }
  return value;
}
async function authenticatedUser(deps: Dependencies, request: Request): Promise<string> {
  const auth = request.headers.get('Authorization') ?? '';
  if (!/^Bearer [^\s]+$/i.test(auth) || auth.length > 16384) throw new HttpError(401,'Log in to manage film alerts.','login_required');
  const res = await external(deps.fetch ?? fetch, `${projectUrl(deps.env)}/auth/v1/user`, {
    method:'GET',headers:{apikey:required(deps.env,'SUPABASE_ANON_KEY'),Authorization:auth},
  });
  if (!res.ok) throw new HttpError(401,'Please log in again.','invalid_session');
  const user = await res.json() as JsonObject;
  if (typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id) || user.is_anonymous === true || typeof user.email !== 'string' || !user.email) {
    throw new HttpError(401,'Log in with a London Screenings account.','invalid_session');
  }
  return user.id;
}
function candidate(raw: JsonObject): JsonObject | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || raw.id <= 0 || typeof raw.title !== 'string' || !raw.title.trim()) return null;
  const year = typeof raw.release_date === 'string' && /^\d{4}-/.test(raw.release_date) ? Number(raw.release_date.slice(0,4)) : null;
  return {tmdbId:raw.id,title:raw.title.trim().slice(0,500),releaseYear:year && year>=1870 && year<=2200 ? year : null,
    posterPath:typeof raw.poster_path === 'string' && raw.poster_path.startsWith('/') ? raw.poster_path.slice(0,500) : null,
    overview:typeof raw.overview === 'string' ? raw.overview.slice(0,2000) : ''};
}
async function tmdb(deps: Dependencies, path: string): Promise<JsonObject> {
  const res = await external(deps.fetch ?? fetch,`${tmdbBase}${path}`,{headers:{Authorization:`Bearer ${required(deps.env,'TMDB_READ_ACCESS_TOKEN')}`,Accept:'application/json'}});
  if (res.status === 404) throw new HttpError(404,'The selected film is not available.','film_not_found');
  if (!res.ok) throw new HttpError(503,'Film information is temporarily unavailable.','tmdb_unavailable');
  try { return await res.json() as JsonObject; } catch { throw new HttpError(503,'Film information is temporarily unavailable.','invalid_response'); }
}
async function api(deps: Dependencies, request: Request, body: JsonObject): Promise<unknown> {
  const userId = await authenticatedUser(deps,request);
  const action = body.action;
  if (typeof action !== 'string' || !actions.has(action)) throw new HttpError(400,'Unsupported action.','invalid_action');
  keys(body,action==='search'?['action','query']:['follow','remove'].includes(action)?['action','tmdbId']:['action']);
  // Quotas commit before the provider request and cannot be reset by retries.
  const budget = await rpc(deps,'screening_alerts_budget',{p_user_id:userId,p_action:action}) as JsonObject;
  if (budget?.allowed !== true) throw new HttpError(429,'Too many requests. Please retry shortly.','rate_limited',Number(budget?.retry_after)||60);
  if (action==='read') return rpc(deps,'screening_alerts_read',{p_user_id:userId});
  if (action==='search') {
    if (typeof body.query !== 'string' || body.query.trim().length<2 || body.query.trim().length>200) throw new HttpError(400,'Enter 2–200 characters to search.','invalid_query');
    const value = await tmdb(deps,`/search/movie?include_adult=false&query=${encodeURIComponent(body.query.trim())}`);
    const results = Array.isArray(value.results)?value.results:[];
    return {candidates:results.slice(0,20).map(x=>candidate(x as JsonObject)).filter(Boolean),sending_enabled:false};
  }
  const parameters: JsonObject = {p_user_id:userId,p_action:action};
  if (action==='follow' || action==='remove') parameters.p_tmdb_id = integer(body.tmdbId);
  if (action==='follow') {
    const id = parameters.p_tmdb_id as number;
    const film = candidate(await tmdb(deps,`/movie/${id}`));
    if (!film || film.tmdbId!==id) throw new HttpError(503,'The film service returned an invalid film.','invalid_response');
    Object.assign(parameters,{p_title:film.title,p_year:film.releaseYear,p_poster:film.posterPath});
  }
  return rpc(deps,'screening_alerts_request',parameters);
}
async function constantTimeEqual(a: string,b: string): Promise<boolean> {
  const encode = (s: string)=>new TextEncoder().encode(s);
  const [x,y] = await Promise.all([crypto.subtle.digest('SHA-256',encode(a)),crypto.subtle.digest('SHA-256',encode(b))]);
  const left=new Uint8Array(x),right=new Uint8Array(y);let diff=0;
  for(let i=0;i<left.length;i++) diff|=left[i]^right[i];
  return diff===0;
}
export function createStage1Handler(mode: 'api'|'worker', deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const headers: Record<string,string> = {'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'};
    try {
      const origin = request.headers.get('Origin');
      if (mode==='api' && origin) {
        const allowed = new URL(required(deps.env,'SCREENING_ALERTS_APP_URL')).origin;
        if (origin!==allowed) throw new HttpError(403,'This origin is not allowed.','origin_denied');
        headers['Access-Control-Allow-Origin']=origin;
        headers['Access-Control-Allow-Headers']='authorization, apikey, content-type, x-client-info';
        headers['Access-Control-Allow-Methods']='POST, OPTIONS';
      }
      if (request.method==='OPTIONS' && mode==='api') return new Response(null,{status:204,headers});
      if (request.method!=='POST') throw new HttpError(405,'Use POST.','method_not_allowed');
      if (mode==='worker') {
        const secret=required(deps.env,'SCREENING_ALERTS_WORKER_SECRET');
        if (secret.length<32) throw new HttpError(503,'Worker secret must have at least 32 characters.','not_configured');
        const provided=request.headers.get('x-screening-alerts-worker-secret')??'';
        if (provided.length>512 || !await constantTimeEqual(secret,provided)) throw new HttpError(401,'Worker authentication required.','worker_auth_required');
      }
      const body=await readBody(request);
      let result: unknown;
      if (mode==='api') result=await api(deps,request,body);
      else {
        keys(body,['action','batchSize']);
        if (body.action==='report') { if(body.batchSize!==undefined) throw new HttpError(400,'Batch size only applies to detection.','invalid_request'); result=await rpc(deps,'screening_alerts_report',{}); }
        else if(body.action==='detect') result=await rpc(deps,'screening_alerts_detect',{p_batch_size:body.batchSize===undefined?500:integer(body.batchSize,1000)});
        else throw new HttpError(400,'Use detect or report.','invalid_action');
      }
      return new Response(JSON.stringify(result),{status:200,headers});
    } catch (error) {
      const e=error instanceof HttpError ? error : new HttpError(503,'Screening Alerts is temporarily unavailable.','service_unavailable');
      if(e.retryAfter) headers['Retry-After']=String(e.retryAfter);
      return new Response(JSON.stringify({error:e.message,code:e.code,sending_enabled:false}),{status:e.status,headers});
    }
  };
}
