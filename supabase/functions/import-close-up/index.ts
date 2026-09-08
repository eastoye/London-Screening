import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders, jsonResponse, londonToUtc, decodeEntities, stripTags,
  startRun, endRun, commitImport,
  type ScreeningRecord, type ImportRunContext,
} from "../_shared/importSafety.ts";

const FEED_URL="https://www.ticketsource.co.uk/ticketshop/iframe/promoter.php?id=24089&target=";
const OFFICIAL_LISTING_URL="https://www.closeupfilmcentre.com/film_programmes/";
const CLOSE_UP_BASE="https://www.closeupfilmcentre.com";
const CINEMA_NAME="Close-Up Film Centre";
const MIN_SCREENINGS=3;
const SOURCE_PREFIX="closeup:ticketsource";
const TICKETSOURCE="https://www.ticketsource.co.uk";
const FETCH_HEADERS={
  "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language":"en-GB,en;q=0.9",
};

interface ParsedScreening {
  performanceId:string; eventHash:string; movieTitle:string; startTime:string;
  bookingUrl:string|null; eventUrl:string; artworkUrl:string|null; soldOut:boolean;
  availabilityStatus:"available"|"sold_out"|"unknown"; filmTitleHint:string|null;
  screeningLabel:string|null; screeningTags:Array<"introduction"|"double_bill">;
  sourceReleaseYear:number|null; sourceRuntimeMinutes:number|null; sourceDirectors:string[];
}
interface OfficialShow { title:string; startTime:string; eventUrl:string }
interface OfficialFilmMetadata { title:string; year:number; runtimeMinutes:number; director:string }
interface OfficialEnrichmentResult {
  status:"enriched"|"listing_unavailable"; matchedScreenings:number; detailPagesFetched:number;
  singleFilmPages:number; compilationPages:number;
}

function decodeHtml(value:string):string {
  const named:Record<string,string>={
    nbsp:" ",amp:"&",quot:'"',apos:"'",rsquo:"'",lsquo:"'",ldquo:'"',rdquo:'"',
    ndash:"–",mdash:"—",hellip:"…",aacute:"á",Aacute:"Á",eacute:"é",Eacute:"É",
    iacute:"í",Iacute:"Í",oacute:"ó",Oacute:"Ó",uacute:"ú",Uacute:"Ú",frac12:"½",
  };
  return decodeEntities(value)
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))
    .replace(/&([A-Za-z][A-Za-z0-9]+);/g,(whole,name)=>named[name]??whole);
}
function cleanText(value:string):string { return decodeHtml(stripTags(value)).replace(/\s+/g," ").trim() }
function fixMojibake(value:string):string {
  if(!/[ÃÂ]/.test(value))return value;
  try{return new TextDecoder().decode(Uint8Array.from([...value].map(c=>c.charCodeAt(0))))}catch{return value}
}
function normaliseForMatch(value:string):string {
  return fixMojibake(cleanText(value)).toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").trim();
}

function titleMetadata(title:string):Pick<ParsedScreening,"filmTitleHint"|"screeningLabel"|"screeningTags"> {
  const labels:string[]=[];
  const tags:ParsedScreening["screeningTags"]=[];
  let hint:string|null=title;
  const strand=title.match(/^(Beyond Human Time|Against All Odds|Hong Kong Film Festival):\s*(.+)$/i);
  if(strand){labels.push(strand[1]);hint=null}
  if(/\bintroduced by\b/i.test(title)){
    labels.push(title.match(/\bintroduced by\b[\s\S]*$/i)?.[0]||"Introduction");
    tags.push("introduction");
    if(!strand)hint=title.replace(/\s*[-–—:]?\s*introduced by\b[\s\S]*$/i,"").trim()||null;
  }
  if(/\s\+\s/.test(title)){labels.push("Double bill");tags.push("double_bill");hint=null}
  if(/^One Minute Volume\b/i.test(title))hint=null;
  return {filmTitleHint:hint,screeningLabel:labels.join("; ")||null,screeningTags:[...new Set(tags)]};
}

function parseFeed(html:string):ParsedScreening[] {
  if(!/<link rel="canonical" href="https:\/\/www\.ticketsource\.com\/close-up-cinema">/i.test(html)||
     !/cdn\.ticketsource\.com\/images\/promoter\/banner\/24089-/i.test(html))
    throw new Error("Unexpected TicketSource promoter feed");
  const starts=[...html.matchAll(/<div class="grid-x align-middle padding-1 eventRow"[^>]*data-id="(\d+)"[^>]*>/g)];
  if(starts.length<MIN_SCREENINGS)throw new Error("TicketSource feed contains too few performance rows");
  const results:ParsedScreening[]=[];
  for(let i=0;i<starts.length;i++){
    const block=html.slice(starts[i].index,starts[i+1]?.index??html.length);
    const performanceId=starts[i][1];
    const eventHash=block.match(/eventhash=(e-[a-z0-9]+)(?:&|&amp;)/i)?.[1];
    const rawTitle=block.match(/<span itemprop="name">([\s\S]*?)<\/span>/)?.[1];
    const local=block.match(/itemprop="startDate" content="((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}))"/)||null;
    const venues=[...block.matchAll(/itemprop="location"[\s\S]*?<span itemprop="name">([\s\S]*?)<\/span>/g)].map(m=>cleanText(m[1]));
    if(!eventHash||!rawTitle||!local)throw new Error("Incomplete TicketSource performance "+performanceId);
    if(venues.length!==1||venues[0]!=="Close-Up Cinema")throw new Error("Unexpected TicketSource venue for "+performanceId);
    const movieTitle=fixMojibake(cleanText(rawTitle));
    const utc=londonToUtc(Number(local[2]),Number(local[3]),Number(local[4]),Number(local[5]),Number(local[6]));
    const bookingToken=block.match(/href="\/booking\/init\/([A-Z0-9]+)(?:\?iframe=true)?"/i)?.[1];
    const button=cleanText(block.match(/class="button-text">([\s\S]*?)<\/span>|class="button-text">([\s\S]*?)<\/div>/i)?.slice(1).find(Boolean)||"");
    const availability=cleanText(block.match(/class="availability[^>]*>([\s\S]*?)<\/div>/i)?.[1]||"");
    const soldOut=/^sold out$/i.test(button);
    const openForSale=Boolean(bookingToken)&&(/tickets? available/i.test(availability)||/^book now$/i.test(button));
    if(soldOut&&bookingToken)throw new Error("Conflicting TicketSource availability for "+performanceId);
    const image=block.match(/<img\b[^>]*src="(https:\/\/cdn\.ticketsource\.com\/images\/promoter\/banner\/[^"]+)"/i)?.[1]||null;
    results.push({
      performanceId,eventHash,movieTitle,startTime:utc.toISOString(),
      bookingUrl:bookingToken?`${TICKETSOURCE}/booking/init/${bookingToken}`:null,
      eventUrl:`${TICKETSOURCE}/close-up-cinema/${eventHash}`,
      artworkUrl:image&&!/default-other\.jpg/i.test(image)?decodeHtml(image):null,
      soldOut,availabilityStatus:soldOut?"sold_out":openForSale?"available":"unknown",
      sourceReleaseYear:null,sourceRuntimeMinutes:null,sourceDirectors:[],...titleMetadata(movieTitle),
    });
  }
  if(new Set(results.map(r=>r.performanceId)).size!==results.length)throw new Error("Duplicate TicketSource performance IDs");
  return results;
}

function absoluteCloseUpUrl(value:string):string|null {
  try{
    const url=new URL(decodeHtml(value),CLOSE_UP_BASE);
    return url.origin===CLOSE_UP_BASE&&/^\/film_programmes\/\d{4}\//.test(url.pathname)?url.href:null;
  }catch{return null}
}
function parseOfficialShows(html:string):OfficialShow[] {
  if(/Just a moment|cf_chl_/i.test(html))throw new Error("Close-Up challenge page returned");
  const match=html.match(/var\s+shows\s*=\s*'(\[[\s\S]*?\])'\s*;/);
  if(!match)throw new Error("Close-Up shows data missing");
  const values=JSON.parse(match[1].replace(/\\'/g,"'")) as Array<Record<string,unknown>>;
  const shows:OfficialShow[]=[];
  for(const value of values){
    const title=fixMojibake(cleanText(String(value.title||"")));
    const eventUrl=absoluteCloseUpUrl(String(value.film_url||""));
    const local=String(value.show_time||"").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):\d{2}$/);
    if(!title||!eventUrl||!local)continue;
    shows.push({title,eventUrl,startTime:londonToUtc(Number(local[1]),Number(local[2]),Number(local[3]),Number(local[4]),Number(local[5])).toISOString()});
  }
  if(shows.length<MIN_SCREENINGS)throw new Error("Close-Up shows data contains too few valid rows");
  return shows;
}

function parseOfficialDetail(html:string):{films:OfficialFilmMetadata[];artworkUrl:string|null} {
  if(/Just a moment|cf_chl_/i.test(html))throw new Error("Close-Up challenge page returned");
  const supportStart=html.search(/id=["']film_program_support["']/i);
  if(supportStart<0)throw new Error("Close-Up film detail container missing");
  const relativeEnd=html.slice(supportStart).search(/<table\b[^>]*id=["']addform["']/i);
  const support=html.slice(supportStart,relativeEnd>0?supportStart+relativeEnd:html.length);
  const films:OfficialFilmMetadata[]=[];
  for(const paragraph of support.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)){
    const strong=paragraph[1].match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i);
    if(!strong)continue;
    const title=fixMojibake(cleanText(strong[1]));
    const credits=fixMojibake(cleanText(paragraph[1].replace(strong[0]," ")));
    const meta=credits.match(/^(.{1,120}?),\s*((?:19|20)\d{2}),\s*(\d{1,3})\s*min\b/i);
    if(!title||!meta)continue;
    const director=meta[1].replace(/^[-–—,:\s]+|[-–—,:\s]+$/g,"").trim();
    if(director)films.push({title,director,year:Number(meta[2]),runtimeMinutes:Number(meta[3])});
  }
  const unique=[...new Map(films.map(f=>[`${normaliseForMatch(f.title)}|${f.year}|${f.runtimeMinutes}|${normaliseForMatch(f.director)}`,f])).values()];
  const ogImage=html.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1]
    ||html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1];
  let artworkUrl:string|null=null;
  if(ogImage)try{
    const url=new URL(decodeHtml(ogImage),CLOSE_UP_BASE);
    if(url.protocol==="https:"&&url.hostname==="www.closeupfilmcentre.com")artworkUrl=url.href;
  }catch{/* optional artwork */}
  return {films:unique,artworkUrl};
}

async function fetchHtml(url:string,timeoutMs:number):Promise<string> {
  const response=await fetch(url,{headers:FETCH_HEADERS,redirect:"follow",signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const html=await response.text();
  if(html.length<1000)throw new Error("Suspiciously short HTML response");
  return html;
}

async function enrichFromOfficialPages(rows:ParsedScreening[]):Promise<OfficialEnrichmentResult> {
  let officialShows:OfficialShow[];
  try{officialShows=parseOfficialShows(await fetchHtml(OFFICIAL_LISTING_URL,10000))}
  catch(error){
    console.warn("[import-close-up] official enrichment unavailable:",error);
    return {status:"listing_unavailable",matchedScreenings:0,detailPagesFetched:0,singleFilmPages:0,compilationPages:0};
  }
  const matches=new Map<string,OfficialShow>();
  for(const row of rows){
    const candidates=officialShows.filter(show=>show.startTime===row.startTime&&normaliseForMatch(show.title)===normaliseForMatch(row.movieTitle));
    if(candidates.length===1)matches.set(row.performanceId,candidates[0]);
  }
  const urls=[...new Set([...matches.values()].map(match=>match.eventUrl))];
  const details=new Map<string,ReturnType<typeof parseOfficialDetail>>();
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,urls.length)},async()=>{
    while(next<urls.length){
      const url=urls[next++];
      try{details.set(url,parseOfficialDetail(await fetchHtml(url,8000)))}
      catch(error){console.warn(`[import-close-up] optional detail failed ${url}:`,error)}
    }
  }));
  let singleFilmPages=0,compilationPages=0;
  const counted=new Set<string>();
  for(const row of rows){
    const match=matches.get(row.performanceId);
    if(!match)continue;
    row.eventUrl=match.eventUrl;
    const detail=details.get(match.eventUrl);
    if(!detail)continue;
    if(!counted.has(match.eventUrl)){
      counted.add(match.eventUrl);
      if(detail.films.length===1)singleFilmPages++;
      else if(detail.films.length>1)compilationPages++;
    }
    if(detail.artworkUrl)row.artworkUrl=detail.artworkUrl;
    if(detail.films.length===1){
      const film=detail.films[0];
      row.filmTitleHint=film.title;row.sourceReleaseYear=film.year;
      row.sourceRuntimeMinutes=film.runtimeMinutes;row.sourceDirectors=[film.director];
    }else if(detail.films.length>1){
      row.filmTitleHint=null;row.sourceReleaseYear=null;row.sourceRuntimeMinutes=null;row.sourceDirectors=[];
    }
  }
  return {status:"enriched",matchedScreenings:matches.size,detailPagesFetched:details.size,singleFilmPages,compilationPages};
}

async function fetchFeed():Promise<string> {
  let lastError="";
  for(let attempt=1;attempt<=2;attempt++)try{
    const html=await fetchHtml(FEED_URL,20000);
    if(html.length<10000)throw new Error("Suspiciously short TicketSource response");
    return html;
  }catch(error){
    lastError=error instanceof Error?error.message:String(error);
    if(/HTTP 429/.test(lastError)||attempt===2)break;
    await new Promise(resolve=>setTimeout(resolve,750));
  }
  throw new Error(lastError||"TicketSource feed unavailable");
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:200,headers:corsHeaders});
  const startedAt=new Date();
  const supabaseUrl=Deno.env.get("SUPABASE_URL"),serviceRoleKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!supabaseUrl||!serviceRoleKey)return jsonResponse({success:false,error:"Missing Supabase credentials."},500);
  const supabase=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const ctx:ImportRunContext={supabase,cinemaName:CINEMA_NAME,minScreenings:MIN_SCREENINGS,startedAt};
  const run=await startRun(ctx);
  if(run.blocked)return jsonResponse({success:false,error:"Another Close-Up import is running.",blocked:true},409);
  if(run.error||!run.runId)return jsonResponse({success:false,error:run.error||"Could not start run."},500);
  let found=0;
  try{
    const parsed=parseFeed(await fetchFeed());found=parsed.length;
    const now=new Date(),upcoming=parsed.filter(row=>new Date(row.startTime)>now);
    if(upcoming.length<MIN_SCREENINGS)throw new Error(`Unusually low future count (${upcoming.length})`);
    const official=await enrichFromOfficialPages(upcoming);
    const {data:oldRows,error:oldError}=await supabase.from("screenings")
      .select("source_reference,movie_title,start_time,booking_url,film_title_hint,source_release_year,source_runtime_minutes,source_directors,source_event_url,verified_artwork_url")
      .eq("cinema_name",CINEMA_NAME).gt("start_time",now.toISOString());
    if(oldError)throw new Error("Cannot read existing Close-Up references: "+oldError.message);
    const oldByTime=new Map<string,typeof oldRows>();
    for(const old of oldRows||[]){const time=new Date(old.start_time).toISOString();const list=oldByTime.get(time)||[];list.push(old);oldByTime.set(time,list)}
    const records:ScreeningRecord[]=upcoming.map(row=>{
      const sameTime=oldByTime.get(row.startTime)||[];
      const strong=sameTime.filter(candidate=>normaliseForMatch(candidate.movie_title)===normaliseForMatch(row.movieTitle)||candidate.booking_url?.includes(row.eventHash));
      const old=strong.length?strong:sameTime.length===1?sameTime:[];
      if(old.length>1)throw new Error("Ambiguous legacy reference at "+row.startTime);
      const previous=old[0];
      const previousOfficial=previous?.source_event_url?.startsWith(`${CLOSE_UP_BASE}/film_programmes/`)
        &&previous.film_title_hint&&previous.source_release_year&&previous.source_runtime_minutes
        &&Array.isArray(previous.source_directors)&&previous.source_directors.length>0;
      const keepPreviousOfficial=Boolean(previousOfficial&&row.sourceReleaseYear===null);
      return {
        cinema_name:CINEMA_NAME,movie_title:row.movieTitle,start_time:row.startTime,booking_url:row.bookingUrl,
        format:null,sold_out:row.soldOut,source_reference:previous?.source_reference||`${SOURCE_PREFIX}:${row.performanceId}`,
        last_seen_at:new Date().toISOString(),projection_formats:[],accessibility_features:[],programme_types:[],
        availability_status:row.availabilityStatus,
        film_title_hint:keepPreviousOfficial?previous.film_title_hint:row.filmTitleHint,
        source_release_year:keepPreviousOfficial?previous.source_release_year:row.sourceReleaseYear,
        source_runtime_minutes:keepPreviousOfficial?previous.source_runtime_minutes:row.sourceRuntimeMinutes,
        source_directors:keepPreviousOfficial?previous.source_directors:row.sourceDirectors,
        source_countries:[],source_event_url:keepPreviousOfficial?previous.source_event_url:row.eventUrl,screen_name:null,
        screening_label:row.screeningLabel,screening_tags:row.screeningTags,
        verified_artwork_url:keepPreviousOfficial&&previous.verified_artwork_url?previous.verified_artwork_url:row.artworkUrl,
      };
    });
    const {count:previous,error:countError}=await supabase.from("screenings").select("id",{count:"exact",head:true})
      .eq("cinema_name",CINEMA_NAME).eq("active",true).gt("start_time",now.toISOString());
    if(countError)throw new Error(countError.message);
    if((previous??0)>=10&&records.length<Math.ceil((previous??0)*0.5))throw new Error("Suspicious Close-Up count drop");
    const {saved,errors}=await commitImport(ctx,records,now);
    if(errors.length)throw new Error("Import errors: "+errors.join("; "));
    await endRun(ctx,run.runId,"success",parsed.length,saved);
    return jsonResponse({success:true,cinema:CINEMA_NAME,screenings_found:parsed.length,screenings_saved:saved,
      skipped_past:parsed.length-upcoming.length,source:"TicketSource promoter feed",official_enrichment:official,
      examples:records.slice(0,5).map(record=>({movie_title:record.movie_title,start_time:record.start_time,
        source_reference:record.source_reference,booking_url:record.booking_url,sold_out:record.sold_out,
        film_title_hint:record.film_title_hint}))});
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    await endRun(ctx,run.runId,"failed",found,0,message);
    return jsonResponse({success:false,error:message},502);
  }
});
