import {normaliseScreeningTags, type AccessibilityFeature, type ProgrammeType} from './screeningMetadata.ts';
const origin='https://cinemas.bfi.org.uk';
const clean=(s:string)=>s.replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
export function cardMetadata(body:string){
 const href=body.match(/<a\b[^>]*class="card-link"[^>]*href="([^"]+)"/i)?.[1];
 const image=body.match(/class="showImage"[^>]*>[\s\S]*?<img\b[^>]*src="([^"]+)"/i)?.[1];
 const work=body.match(/class="workData"[^>]*>([\s\S]*?)<\/div>/i)?.[1]||'';
 const duration=work.match(/datetime="PT(?:(\d+)H)?(?:(\d+)M)?"/i);
 const years=[...work.matchAll(/<span\b[^>]*>\s*((?:18|19|20|21)\d{2})\s*<\/span>/g)].map(m=>Number(m[1]));
 return {source_directors:[] as string[],source_countries:[] as string[],source_event_url:href?new URL(clean(href),origin).href:null,verified_artwork_url:image?new URL(clean(image),origin).href:null,source_release_year:years.length===1?years[0]:null,source_runtime_minutes:duration?(Number(duration[1]||0)*60+Number(duration[2]||0)||null):null};
}
export function performanceMetadata(label:string,screen:string){
 const accessibility_features:AccessibilityFeature[]=[],programme_types:ProgrammeType[]=[];
 if(/descriptive subtitles|open captions|closed captions/i.test(label))accessibility_features.push('captioned');
 if(/audio description/i.test(label))accessibility_features.push('audio_described');
 if(/relaxed screening/i.test(label))accessibility_features.push('relaxed');
 if(/members[’']? only/i.test(label))programme_types.push('members_only');
 if(/parent\s*(?:&|and)\s*baby/i.test(label))programme_types.push('parent_and_baby');
 if(/seniors[’']? (?:free )?matinee/i.test(label))programme_types.push('seniors');
 return {screen_name:screen||null,screening_label:label||null,screening_tags:normaliseScreeningTags([label]),accessibility_features,programme_types};
}
export function detailMetadata(html:string){
 const field=(name:string)=>clean(html.match(new RegExp('<h2\\b[^>]*>'+name+'<\\/h2>\\s*<span\\b[^>]*>([\\s\\S]*?)<\\/span>','i'))?.[1]||'');
 const director=field('Director'),country=field('Country');
 return {source_directors:director?[director]:[],source_countries:country?country.split(/\s*[,;]\s*/).filter(Boolean):[]};
}
export async function enrichDetails(rows:Array<{source_event_url:string|null;source_directors?:string[];source_countries?:string[]}>){
 const urls=[...new Set(rows.map(r=>r.source_event_url).filter((u):u is string=>Boolean(u)))];
 for(let i=0;i<urls.length;i+=5)await Promise.all(urls.slice(i,i+5).map(async url=>{
  try{
   if(new URL(url).origin!==origin)throw new Error('Unexpected detail origin');
   const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw new Error(String(response.status));
   const html=await response.text();
   if(!/<h2[^>]*>Director<\/h2>/i.test(html))return;
   const metadata=detailMetadata(html);
   for(const row of rows)if(row.source_event_url===url)Object.assign(row,metadata);
  }catch(error){console.warn('Optional BFI detail unavailable',url,String(error));}
 }));
}
