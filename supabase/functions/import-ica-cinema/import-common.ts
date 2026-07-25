import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export type Row={cinema_name:string;movie_title:string;start_time:string;booking_url:string;format:string|null;sold_out:boolean;source_reference:string;last_seen_at:string;active?:boolean};
export const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
export const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
export const clean=(s:unknown)=>String(s??"").replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#(?:39|039);/g,"'").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
export function londonIso(y:number,m:number,d:number,h:number,min:number){
  const probe=new Date(Date.UTC(y,m-1,d,h,min));
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(probe);
  const get=(t:string)=>Number(parts.find(p=>p.type===t)?.value);
  const represented=Date.UTC(get("year"),get("month")-1,get("day"),get("hour"),get("minute"));
  return new Date(probe.getTime()-(represented-probe.getTime())).toISOString();
}
export async function runImporter(req:Request,cinema:string,min:number,parse:(now:Date)=>Promise<Row[]>){
  if(req.method==="OPTIONS")return new Response(null,{headers:cors});
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)return reply({success:false,error:"Missing Supabase credentials"},500);
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}),started=new Date();
  const {data:run,error:startError}=await db.from("import_runs").insert({cinema_name:cinema,status:"running",started_at:started.toISOString()}).select("id").single();
  if(startError)return reply({success:false,blocked:startError.code==="23505",error:startError.message},startError.code==="23505"?409:500);
  try{
    const rows=await parse(new Date());
    const unique=[...new Map(rows.map(r=>[r.source_reference,r])).values()];
    if(unique.length!==rows.length)throw new Error("Duplicate source references returned");
    if(rows.length<min)throw new Error(`Unusually low screening count (${rows.length})`);
    const now=new Date(),{count:previous}=await db.from("screenings").select("id",{count:"exact",head:true}).eq("cinema_name",cinema).eq("active",true).gt("start_time",now.toISOString());
    if((previous??0)>=10&&rows.length<Math.ceil((previous??0)*0.5))throw new Error(`Suspicious count drop from ${previous} to ${rows.length}`);
    const stamp=new Date().toISOString(); rows.forEach(r=>{r.last_seen_at=stamp;r.active=true});
    const {error:upsertError}=await db.from("screenings").upsert(rows,{onConflict:"source_reference"});
    if(upsertError)throw upsertError;
    const {error:pastError}=await db.from("screenings").update({active:false,updated_at:stamp}).eq("cinema_name",cinema).eq("active",true).lt("start_time",now.toISOString());
    if(pastError)throw pastError;
    const {error:missingError}=await db.from("screenings").update({active:false,updated_at:stamp}).eq("cinema_name",cinema).eq("active",true).gt("start_time",now.toISOString()).neq("last_seen_at",stamp);
    if(missingError)throw missingError;
    await db.from("import_runs").update({status:"success",completed_at:new Date().toISOString(),screenings_found:rows.length,screenings_saved:rows.length}).eq("id",run.id);
    return reply({success:true,cinema,screenings_found:rows.length,screenings_saved:rows.length,previous_active:previous??0,examples:rows.slice(0,5)});
  }catch(e){const message=e instanceof Error?e.message:String(e);await db.from("import_runs").update({status:"failed",completed_at:new Date().toISOString(),screenings_found:0,screenings_saved:0,error_message:message}).eq("id",run.id);return reply({success:false,error:message},500)}
}

