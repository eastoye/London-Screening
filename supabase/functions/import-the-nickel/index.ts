import {runImporter,type Row} from "./import-common.ts";
const CINEMA="The Nickel",URL="https://thenickel.co.uk/";
async function parse(now:Date):Promise<Row[]>{const html=await(await fetch(URL)).text();if(html.length<20000)throw new Error("Nickel programme response too small");const data=html.replaceAll('\\"','"'),rows:Row[]=[];for(const m of data.matchAll(/\{"id":(\d+),"filmId":\d+,"screeningDate":"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})"[\s\S]*?"format":"([^"]*)","film":\{"id":\d+,"title":"([^"]*)"[\s\S]*?"ageCertificate":"([^"]*)"\}\}/g)){const iso=(await import("./import-common.ts")).londonIso(Number(m[2]),Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6]));if(new Date(iso)<=now)continue;const title=m[8],format=m[7];rows.push({cinema_name:CINEMA,movie_title:title,start_time:iso,booking_url:`${URL}screening/${m[1]}`,format:format||null,sold_out:false,source_reference:`nickel:${m[1]}`,last_seen_at:now.toISOString()})}return rows}
Deno.serve(req=>runImporter(req,CINEMA,3,parse));

