import {runImporter,type Row} from "./import-common.ts";
const CINEMA="The Nickel",URL="https://thenickel.co.uk/";

function normaliseProgrammeTitle(rawTitle:string):{title:string;festivalLabel:string|null;qAndA:boolean}{
  let title=rawTitle.replace(/\\u0026/gi,"&").trim();
  const festival=/^\s*TFFF:\s*/i.test(title);
  title=title.replace(/^\s*TFFF:\s*/i,"").trim();
  const qAndA=/\s*\+\s*Q&A\s*$/i.test(title);
  if(qAndA)title=title.replace(/\s*\+\s*Q&A\s*$/i,"").trim();
  return {title,festivalLabel:festival?"TFFF":null,qAndA};
}
function mergeFormatLabels(...labels:Array<string|null|undefined>):string|null{
  const unique=[...new Set(labels.map(label=>label?.trim()).filter((label):label is string=>Boolean(label)))];
  return unique.length?unique.join(" · "):null;
}
async function parse(now:Date):Promise<Row[]>{const html=await(await fetch(URL)).text();if(html.length<20000)throw new Error("Nickel programme response too small");const data=html.replaceAll('\\"','"'),rows:Row[]=[];for(const m of data.matchAll(/\{"id":(\d+),"filmId":\d+,"screeningDate":"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})"[\s\S]*?"format":"([^"]*)","film":\{"id":\d+,"title":"([^"]*)"[\s\S]*?"ageCertificate":"([^"]*)"\}\}/g)){const iso=(await import("./import-common.ts")).londonIso(Number(m[2]),Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6]));if(new Date(iso)<=now)continue;const programme=normaliseProgrammeTitle(m[8]),format=mergeFormatLabels(m[7]||null,programme.festivalLabel,programme.qAndA?"Q&A":null);rows.push({cinema_name:CINEMA,movie_title:programme.title,start_time:iso,booking_url:`${URL}screening/${m[1]}`,format,sold_out:false,source_reference:`nickel:${m[1]}`,last_seen_at:now.toISOString()})}return rows}
Deno.serve(req=>runImporter(req,CINEMA,3,parse));


