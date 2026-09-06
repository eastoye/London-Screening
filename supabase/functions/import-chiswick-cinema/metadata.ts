// Only Movie JSON-LD from the current official film page is accepted.
// dateCreated describes a record's creation; it is not a release year.
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
