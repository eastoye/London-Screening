import {decodeEntities,stripTags,type ScreeningRecord} from '../_shared/importSafety.ts';
import {normaliseScreeningTags,normaliseProjectionFormats,parseRuntimeMinutes} from '../_shared/screeningMetadata.ts';

const text=(html:string)=>decodeEntities(stripTags(html)).replace(/\s+/g,' ').trim();
const FILM_TYPES=new Set(['1946778','1946780','1946781','1946783']);
const NON_FILM_TYPES=new Set(['1929076','1952820','1946784','1929080','2011693','2528553','5168']);
// Two products are filed in mixed cinema categories by Savoy. Verified against
// the official event: an author conversation and a separately ticketed workshop.
const NON_FILM_PROGRAMMES=new Set(['6980181','6444749']);

export function filmCatalogue(html:string):string {
 const starts=[...html.matchAll(/<div class="programmetype(\d+) programme twelvecol">/g)];
 if(!starts.length)throw new Error('Missing Savoy source programme categories');
 const kept:string[]=[];
 for(let i=0;i<starts.length;i++){
  const block=html.slice(starts[i].index,starts[i+1]?.index??html.length);
  const type=starts[i][1];
  const id=block.match(/TcsProgramme_(\d+)/)?.[1];
  if(NON_FILM_TYPES.has(type)||NON_FILM_PROGRAMMES.has(id||''))continue;
  // A new category needs review; never silently deactivate its screenings.
  if(!FILM_TYPES.has(type))throw new Error('Unreviewed Savoy programme category '+type);
  if(!id||!/<h2 class="subtitle first">/.test(block))throw new Error('Incomplete Savoy film block');
  kept.push(block);
 }
 return kept.join('\n');
}

export function lumiereLabels(title:string,notes:string){
 // Extract only explicit presentation/event suffixes, never generic title words.
 const suffixes=[...title.matchAll(/(?:\+\s*(?:Q\s*&\s*A(?:\s+TBC)?|(?:Extended\s+)?Intro(?:duction)?)\b|(?:\+\s*Short\s*&\s*Intro\b)|\((?:4K|35mm|70mm|relaxed[ -]screening)\)|\b4K\s*$)/gi)].map(m=>m[0].replace(/^[+(]\s*|\)$/g,'').trim());
 const labels=[...new Set([...suffixes,...(notes?[notes]:[])])];
 const formats=labels.flatMap(l=>[...l.matchAll(/\b(?:4K|35\s*mm|70\s*mm)\b/gi)].map(m=>m[0].replace(/\s/g,'')));
 return {
  screening_label:labels.join('; ')||null,
  screening_tags:normaliseScreeningTags(labels.filter(l=>! /\bTBC\b/i.test(l))),
  accessibility_features:labels.some(l=>/\brelaxed[ -]screening\b/i.test(l))?['relaxed' as const]:[],
  projection_formats:normaliseProjectionFormats(labels),
  format:[...new Set(formats)].join(', ')||null,
 };
}

export function detailMetadata(html:string,url:string):Partial<ScreeningRecord>{
 const block=html.match(/<ul class="metadata"[^>]*>([\s\S]*?)<\/ul>/)?.[1]||'';
 const fields=new Map<string,string>();
 for(const m of block.matchAll(/<li\b[^>]*>\s*<strong>([\s\S]*?)<\/strong>([\s\S]*?)<\/li>/g))fields.set(text(m[1]).replace(/:\s*$/,''),text(m[2]));
 const cy=fields.get('Country, year')?.match(/^([^|]+)\|\s*((?:18|19|20|21)\d{2})$/);
 const director=fields.get('Director(s)');
 const title=text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]||'');
 const image=html.match(/<meta property="og:image" content="(https:\/\/[^\"]+)"/)?.[1];
 return {
  film_title_hint:title||null,source_event_url:url,
  source_release_year:cy?Number(cy[2]):null,
  source_countries:cy?cy[1].split(/\s*[,/]\s*/).map(v=>v.trim()).filter(Boolean):[],
  source_runtime_minutes:parseRuntimeMinutes(fields.get('Duration')),
  source_directors:director?director.split(/\s*[,;]\s*/).filter(Boolean):[],
  verified_artwork_url:image?decodeEntities(image):null,
 };
}

export async function enrichLumiere(records:ScreeningRecord[]):Promise<number>{
 async function get(url:string){
  const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Institut français HTTP '+response.status);
  const html=await response.text();
  if(!/<html\b/i.test(html))throw new Error('Incomplete Institut français HTML');
  return html;
 }
 // This official all-dates Films listing supplies detail URLs directly. /cinema/
 // is a curated landing page; its apparent page/N links repeat the same cards.
 const listing=await get('https://www.institut-francais.org.uk/whats-on/?type=72&period=any&location=onsite');
 const urls=[...new Set([...listing.matchAll(/<article class="card card--horizontal card--film">([\s\S]*?)<\/article>/g)].flatMap(m=>{
  const url=m[1].match(/<a href="(https:\/\/www\.institut-francais\.org\.uk\/cinema\/[^"?#]+\/)"/)?.[1];
  return url?[url]:[];
 }))];
 if(urls.length<5||urls.length>180)throw new Error('Unexpected official film-detail discovery count');
 const evidence=new Map<string,{url:string,metadata:Partial<ScreeningRecord>}>();
 let failedPages=0;
 for(let i=0;i<urls.length;i+=4){
  const pages=await Promise.allSettled(urls.slice(i,i+4).map(async url=>({url,html:await get(url)})));
  for(const page of pages){
   if(page.status==='rejected'){failedPages++;continue;}
   const {url,html}=page.value;
   // Do not collect related-film/footer booking links. The primary event content
   // precedes the related-content section; its exact performance IDs are evidence.
   const main=html.slice(html.indexOf('<h1'));
   const content=main.split(/<section[^>]*class="[^"]*(?:related|recommend)/)[0].split('<footer')[0];
   const metadata=detailMetadata(html,url);
   // Require labelled film credits; missing optional detail fields stay empty.
   if(!/<ul class="metadata"/.test(content))continue;
   for(const m of content.matchAll(/TcsPerformance_(\d+)/g)){
    const old=evidence.get(m[1]);
    if(old&&old.url!==url){
     // Duplicate official pages are not enough to choose between conflicting films.
     if(old.metadata.film_title_hint!==metadata.film_title_hint)throw new Error('Conflicting official film evidence for performance '+m[1]);
    }else evidence.set(m[1],{url,metadata});
   }
  }
 }
 let enriched=0;
 for(const row of records){
  const item=evidence.get(row.source_reference.replace(/^cinelumiere:/,''));
  if(item){Object.assign(row,item.metadata);enriched++;}
 }
 if(!enriched)throw new Error('Official film-detail pages matched no Savoy performances');
 console.log('Ciné Lumière detail pages='+urls.length+'; failed='+failedPages+'; exact performance metadata matches='+enriched+'/'+records.length);
 return enriched;
}
