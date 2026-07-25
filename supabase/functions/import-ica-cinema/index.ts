import {clean,londonIso,runImporter,type Row} from "./import-common.ts";
const CINEMA="ICA Cinema",BASE="https://www.ica.art",LIST=`${BASE}/films`;
const months:Record<string,number>={Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
async function parse(now:Date):Promise<Row[]>{
 const html=await (await fetch(LIST)).text(); if(html.length<10000)throw new Error("ICA programme response too small");
 const paths=[...html.matchAll(/href="(\/films\/[^"]+)"/g)].map(m=>m[1]).filter(p=>p.split("/").length===3);
 const unique=[...new Set(paths)],rows:Row[]=[],errors:string[]=[];
 for(let i=0;i<unique.length;i+=6){
  const pages=await Promise.all(unique.slice(i,i+6).map(async path=>{let last:unknown;for(let attempt=1;attempt<=3;attempt++){try{const response=await fetch(BASE+path);if(!response.ok)throw new Error(`ICA page ${response.status}: ${path}`);return {path,html:await response.text()}}catch(error){last=error;if(attempt<3)await new Promise(resolve=>setTimeout(resolve,attempt*400))}}throw last}));
  for(const page of pages){
   const title=clean(page.html.match(/<meta property="og:title" content="ICA \| ([^"]+)"/)?.[1]??page.html.match(/<div class="title ">([\s\S]*?)<\/div>/)?.[1]);
   const booking=page.html.match(/location\.href="(\/book\/(\d+))"/) ; if(!booking||!title)continue;
   const blocks=[...page.html.matchAll(/<div class='performance future'>([\s\S]*?)<\/div>\s*<\/div>|<div class='performance future'>([\s\S]*?)(?=<div class='performance|<\/div><details)/g)];
   const section=page.html.match(/<div class="performance-list">([\s\S]*?)<\/div><details/)?.[1]??"";
   const perf=[...section.matchAll(/<div class='performance future'>([\s\S]*?)(?=<div class='performance future'|$)/g)];
   for(const m of perf){const b=m[1],dm=b.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})/),tm=b.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i),screen=clean(b.match(/<div class='venue'>(.*?)<\/div>/)?.[1]);if(!dm||!tm){errors.push(page.path);continue}let h=Number(tm[1]);if(tm[3].toLowerCase()==="pm"&&h!==12)h+=12;if(tm[3].toLowerCase()==="am"&&h===12)h=0;const iso=londonIso(Number(dm[4]),months[dm[3]],Number(dm[2]),h,Number(tm[2]));if(new Date(iso)<=now)continue;const formats=[/70mm/i.test(title)?"70mm":"",/35mm/i.test(title)?"35mm":"",/\b4K\b/i.test(title)?"4K":"",/\bIMAX\b/i.test(title)?"IMAX":"",/\b3D\b/i.test(title)?"3D":"",/Dolby Atmos/i.test(title)?"Dolby Atmos":"",/\bDCP\b/i.test(title)?"DCP":""].filter(Boolean);rows.push({cinema_name:CINEMA,movie_title:title,start_time:iso,booking_url:BASE+booking[1],format:formats.join(", ")||null,sold_out:false,source_reference:`ica:${booking[2]}:${iso}:${screen}`,last_seen_at:now.toISOString()})}
  }
 }
 if(errors.length)throw new Error(`ICA performance parsing incomplete (${errors.length})`);return rows;
}
Deno.serve(req=>runImporter(req,CINEMA,3,parse));

