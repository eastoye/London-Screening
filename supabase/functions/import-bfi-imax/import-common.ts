import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export type Venue = "southbank" | "imax";
export type Row = { cinema_name:string; movie_title:string; start_time:string; booking_url:string|null; format:string|null; sold_out:boolean; source_reference:string; last_seen_at:string; active?:boolean };

const SOURCE = "https://cinemas.bfi.org.uk";
const months:Record<string,number>={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
export const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const decode=(s:string)=>s.replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#(?:39|039);/g,"'").replace(/&nbsp;/g," ").replace(/&ndash;|&#8211;/g,"–").replace(/&mdash;|&#8212;/g,"—");
const clean=(s:string)=>decode(s.replace(/<[^>]*>/g," ")).replace(/\s+/g," ").trim();

function londonIso(y:number,m:number,d:number,h:number,min:number){
  const probe=new Date(Date.UTC(y,m-1,d,h,min));
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(probe);
  const get=(t:string)=>Number(parts.find(p=>p.type===t)?.value);
  return new Date(probe.getTime()-(Date.UTC(get("year"),get("month")-1,get("day"),get("hour"),get("minute"))-probe.getTime())).toISOString();
}

function yearFor(month:number,now:Date){
  const london=new Date(now.toLocaleString("en-US",{timeZone:"Europe/London"}));
  let year=london.getFullYear(),current=london.getMonth()+1;
  if(month<=3&&current>=10)year++;
  if(month>=10&&current<=3)year--;
  return year;
}

function formats(text:string,venue:Venue){
  const found:string[]=[];
  const add=(v:string)=>{if(!found.includes(v))found.push(v)};
  if(/\bIMAX\s*70mm\b/i.test(text)){add("IMAX");add("70mm")}
  else if(/\bIMAX\b/i.test(text)||venue==="imax")add("IMAX");
  for(const [re,value] of [[/\b16mm\b/i,"16mm"],[/\b35mm\b/i,"35mm"],[/\b70mm\b/i,"70mm"],[/\b4K\b/i,"4K"],[/\b3D\b/i,"3D"],[/Dolby Atmos/i,"Dolby Atmos"],[/\bDCP\b/i,"DCP"]] as const)if(re.test(text))add(value);
  return found.join(", ")||null;
}

function parseDateTime(label:string,now:Date){
  const m=label.match(/^(\d{1,2}):(\d{2})\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})\s+([A-Za-z]+)/i);
  if(!m)return null;const month=months[m[4].toLowerCase()];if(!month)return null;
  return londonIso(yearFor(month,now),month,Number(m[3]),Number(m[1]),Number(m[2]));
}

export async function fetchBfiRows(venue:Venue,now:Date):Promise<Row[]>{
  const paths=venue==="imax"?["/whats-on","/bfi-imax"]:["/whats-on"];
  const responses=await Promise.all(paths.map(path=>fetch(SOURCE+path,{headers:{"User-Agent":"Cinema Listings importer/1.0","Accept":"text/html"}})));
  const failed=responses.find(response=>!response.ok);if(failed)throw new Error(`BFI programme returned ${failed.status}`);
  const html=(await Promise.all(responses.map(response=>response.text()))).join("\n");
  if(html.length<(venue==="southbank"?500000:50000))throw new Error(`BFI programme response unexpectedly small (${html.length})`);
  const cinema=venue==="southbank"?"BFI Southbank":"BFI IMAX";
  const prefix=venue==="southbank"?"bfi-southbank":"bfi-imax";
  const rows:Row[]=[];
  for(const card of html.split(/<article\b[^>]*class="[^"]*showCard[^"]*"[^>]*>/i).slice(1)){
    const end=card.indexOf("</article>"); if(end<0)continue; const body=card.slice(0,end);
    const title=clean(body.match(/<h3\b[^>]*>[\s\S]*?<a\b[^>]*class="card-link"[^>]*>([\s\S]*?)<\/a>/i)?.[1]||"");
    if(!title)continue;
    const beforeTitle=clean(body.slice(0,Math.max(0,body.indexOf("<h3"))));
    if(/\b(?:Talk|Exhibition|Adult course|Member Salon|Library Lates)\b/i.test(beforeTitle))continue;
    const sectionRe=/<h4\b[^>]*aria-label="((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}\s+[A-Za-z]+)"[^>]*>[\s\S]*?<ul\b[^>]*>([\s\S]*?)<\/ul>/gi;
    let section:RegExpExecArray|null;
    while((section=sectionRe.exec(body))){
      const dateText=section[1];
      for(const rawLi of section[2].split(/<li\b[^>]*>/i).slice(1)){
        const li=rawLi.split("</li>")[0];
        const link=li.match(/<a\b[^>]*href="([^"]+)"[^>]*aria-label="([^"]+)"[^>]*data-ga-event="booking_click"[^>]*>/i);
        const disabled=li.match(/<button\b[^>]*aria-disabled="true"[^>]*>(\d{1,2}:\d{2})<\/button>/i);
        if(!link&&!disabled)continue;
        const label=decode(link?.[2]||`${disabled![1]} ${dateText}`);
        const tagText=clean([...li.matchAll(/<div\b[^>]*class="tagsWrapper"[^>]*>([\s\S]*?)<\/div>/gi)].map(m=>m[1]).join(" "));
        const isImax=/BFI IMAX|IMAX, Waterloo/i.test(label);
        const isSouthbank=/\bNFT[1-4]\b|General Admission|Studio/i.test(label);
        if(venue==="imax"&&((link&&!isImax)||(!link&&!/\bIMAX\b/i.test(tagText))))continue;
        if(venue==="southbank"&&((link&&!isSouthbank)||(!link&&/\bIMAX\b/i.test(tagText))))continue;
        const start=parseDateTime(label,now);if(!start||new Date(start)<=now)continue;
        const uuid=link?.[1].match(/performance_ids%3D([0-9a-f-]{36})/i)?.[1]?.toUpperCase();
        const sold=/\bSold out\b/i.test(li);
        const screen=clean(label.match(/(?:Screen\s+(.+)|((?:BFI )?IMAX, Waterloo))$/i)?.[1]||label.match(/(?:Screen\s+(.+)|((?:BFI )?IMAX, Waterloo))$/i)?.[2]||"");
        const fallback=`${title}|${start}|${screen||venue}`.toLowerCase().replace(/[^a-z0-9|:-]+/g,"-");
        rows.push({cinema_name:cinema,movie_title:title,start_time:start,booking_url:link?decode(link[1]):null,format:formats(`${title} ${tagText}`,venue),sold_out:sold,source_reference:`${prefix}:${uuid||fallback}`,last_seen_at:now.toISOString()});
      }
    }
  }
  const byReference=new Map<string,Row>();
  for(const row of rows){
    const prior=byReference.get(row.source_reference);
    if(prior&&(prior.movie_title!==row.movie_title||prior.start_time!==row.start_time))throw new Error(`Conflicting BFI source reference ${row.source_reference}`);
    if(!prior||(!prior.booking_url&&row.booking_url))byReference.set(row.source_reference,row);
  }
  return [...byReference.values()];
}

export async function runImporter(req:Request,venue:Venue,min:number){
  if(req.method==="OPTIONS")return new Response(null,{headers:cors});
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)return reply({success:false,error:"Missing Supabase credentials"},500);
  const cinema=venue==="southbank"?"BFI Southbank":"BFI IMAX",db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}),started=new Date();
  const {data:run,error:startError}=await db.from("import_runs").insert({cinema_name:cinema,status:"running",started_at:started.toISOString()}).select("id").single();
  if(startError)return reply({success:false,blocked:startError.code==="23505",error:startError.message},startError.code==="23505"?409:500);
  try{
    const rows=await fetchBfiRows(venue,new Date());
    if(rows.length<min)throw new Error(`Unusually low screening count (${rows.length})`);
    const now=new Date(),{count:previous}=await db.from("screenings").select("id",{count:"exact",head:true}).eq("cinema_name",cinema).eq("active",true).gt("start_time",now.toISOString());
    if((previous??0)>=10&&rows.length<Math.ceil((previous??0)*0.5))throw new Error(`Suspicious count drop from ${previous} to ${rows.length}`);
    const stamp=new Date().toISOString();rows.forEach(r=>{r.last_seen_at=stamp;r.active=true});
    for(let i=0;i<rows.length;i+=150){const {error}=await db.from("screenings").upsert(rows.slice(i,i+150),{onConflict:"source_reference"});if(error)throw error}
    const {error:past}=await db.from("screenings").update({active:false,updated_at:stamp}).eq("cinema_name",cinema).eq("active",true).lt("start_time",now.toISOString());if(past)throw past;
    const {error:missing}=await db.from("screenings").update({active:false,updated_at:stamp}).eq("cinema_name",cinema).eq("active",true).gt("start_time",now.toISOString()).neq("last_seen_at",stamp);if(missing)throw missing;
    await db.from("import_runs").update({status:"success",completed_at:new Date().toISOString(),screenings_found:rows.length,screenings_saved:rows.length}).eq("id",run.id);
    return reply({success:true,cinema,screenings_found:rows.length,screenings_saved:rows.length,previous_active:previous??0,sold_out:rows.filter(r=>r.sold_out).length,formats:[...new Set(rows.map(r=>r.format).filter(Boolean))],examples:rows.slice(0,5)});
  }catch(e){const message=e instanceof Error?e.message:String(e);await db.from("import_runs").update({status:"failed",completed_at:new Date().toISOString(),screenings_found:0,screenings_saved:0,error_message:message}).eq("id",run.id);return reply({success:false,error:message},500)}
}
