import {normaliseScreeningTags,normaliseProjectionFormats} from "../_shared/screeningMetadata.ts";
import type {ScreeningRecord} from "../_shared/importSafety.ts";
// Movie JSON-LD supplies basic credits. The public API's explicit releaseDate
// supplies the year: the page's dateCreated is a different field.
export function movieMetadata(html:string,eventUrl:string){
 const movies:Record<string,unknown>[]=[];
 for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{
   const parsed=JSON.parse(match[1]);
   for(const item of Array.isArray(parsed)?parsed:parsed['@graph']||[parsed])if(item?.['@type']==='Movie')movies.push(item);
  }catch{/* Optional malformed JSON-LD must not discard valid times. */}
 }
 const movie=movies.length===1?movies[0]:null;
 const duration=typeof movie?.duration==='string'?movie.duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/):null;
 const directors=Array.isArray(movie?.director)?movie.director:movie?.director?[movie.director]:[];
 const image=typeof movie?.image==='string'&&/^https:\/\//i.test(movie.image)?movie.image:null;
 return {
  film_title_hint:typeof movie?.name==='string'?movie.name:null,
  source_event_url:eventUrl,
  source_runtime_minutes:duration?(Number(duration[1]||0)*60+Number(duration[2]||0)||null):null,
  source_directors:directors.map(d=>typeof d==='object'&&d&&'name' in d&&typeof d.name==='string'?d.name:null).filter((v):v is string=>Boolean(v)),
  verified_artwork_url:image,
 };
}

async function publicQuery(query:string):Promise<Record<string,any>> {
 const response=await fetch('https://www.chiswickcinema.co.uk/graphql',{
  method:'POST',headers:{'Content-Type':'application/json','client-type':'consumer','site-id':'170','circuit-id':'56'},
  body:JSON.stringify({query}),signal:AbortSignal.timeout(20000),
 });
 if(!response.ok)throw new Error('Chiswick public metadata API HTTP '+response.status);
 const body=await response.json();
 if(body.errors||body.error||!body.data)throw new Error('Chiswick public metadata API incomplete response');
 return body.data;
}

// Batch requests use the same public site/circuit context as Chiswick's app.
// Existing HTML performance IDs and times remain authoritative for coverage.
export async function enrichChiswick(records:ScreeningRecord[]):Promise<void>{
 const urls=[...new Set(records.map(r=>r.source_event_url).filter((u):u is string=>Boolean(u)))];
 for(let offset=0;offset<urls.length;offset+=12){
  const batch=urls.slice(offset,offset+12);
  const movies=await publicQuery('{'+batch.map((url,i)=>`m${i}:findMovieBySlug(urlSlug:${JSON.stringify(new URL(url).pathname.split('/').filter(Boolean).pop())}){id releaseDate countryOfOrigin}`).join(' ')+'}');
  const queries=batch.flatMap((_,i)=>movies['m'+i]?.id?[`m${i}:publicShowingsForMovie(movieId:${JSON.stringify(movies['m'+i].id)}){data{id time published seatsRemaining screen{name} showingBadges{displayName title}}}`]:[]);
  const showings=queries.length?await publicQuery('{'+queries.join(' ')+'}'):{};
  for(let i=0;i<batch.length;i++){
   const movie=movies['m'+i];
   if(!movie)continue; // Source may withdraw a movie between requests.
   const date=typeof movie.releaseDate==='string'?movie.releaseDate.match(/^((?:18|19|20|21)\d{2})-\d{2}-\d{2}$/):null;
   const country=typeof movie.countryOfOrigin==='string'?movie.countryOfOrigin.trim():'';
   const countries=/^[A-Z]{2}$/.test(country)?[new Intl.DisplayNames(['en'],{type:'region'}).of(country)||country]:[];
   const list=showings['m'+i]?.data;
   if(!Array.isArray(list))throw new Error('Chiswick missing public showing list');
   for(const row of records.filter(r=>r.source_event_url===batch[i])){
    row.source_release_year=date?Number(date[1]):null;
    row.source_countries=countries;
    const matches=list.filter((s:any)=>'chiswick:'+s.id===row.source_reference);
    if(matches.length>1)throw new Error('Chiswick duplicate API showing ID');
    const showing=matches[0];
    if(!showing)continue;
    if(Date.parse(showing.time)!==Date.parse(row.start_time))throw new Error('Chiswick HTML/API performance time disagreement');
    const labels:string[]=[...new Set<string>((showing.showingBadges||[]).map((b:any)=>String(b.displayName||b.title||'').trim()).filter(Boolean))];
    row.screen_name=typeof showing.screen?.name==='string'?showing.screen.name:null;
    row.screening_label=labels.join('; ')||null;
    row.screening_tags=normaliseScreeningTags(labels);
    row.projection_formats=normaliseProjectionFormats(labels);
    row.format=labels.filter(l=>/^(?:35\s*mm|70\s*mm|IMAX|4K|2K|Digital|Laser|3D)$/i.test(l)).join(', ')||null;
    row.accessibility_features=[];
    if(labels.some(l=>/^(?:captioned|closed captions?|CC|hard of hearing)$/i.test(l)))row.accessibility_features.push('captioned');
    if(labels.some(l=>/^(?:audio described|audio description|AD)$/i.test(l)))row.accessibility_features.push('audio_described');
    if(labels.some(l=>/^relaxed(?: screening)?$/i.test(l)))row.accessibility_features.push('relaxed');
    row.programme_types=[];
    // Chiswick's badge describes Silver Screen as an over-60 discount, open to all.
    if(labels.includes('Silver Screen'))row.programme_types.push('seniors');
    const remaining=showing.seatsRemaining;
    if(typeof remaining==='number'&&Number.isInteger(remaining)&&remaining>=0){
     row.sold_out=remaining===0;
     row.availability_status=remaining===0?'sold_out':showing.published===true?'available':'unknown';
    }
   }
  }
 }
}
