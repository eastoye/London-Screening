import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
let db, now;
const query=async(sql,args=[]) => (await db.query(sql,args)).rows;
const rpc=async(name,args=[]) => (await query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args))[0].value;
const follows=async(user=A,id=348,title='Alien')=>rpc('screening_alerts_request',[user,'follow',id,title,1979,'/alien.jpg']);
async function run(cinema='Prince Charles Cinema',status='success',minutes=10) {
  return (await query(`insert into public.import_runs(cinema_name,status,started_at,completed_at)
    values($1,$2,$3::timestamptz-make_interval(mins=>$4::int),$3::timestamptz-make_interval(mins=>$4::int)+interval '2 minutes') returning id`,[cinema,status,now,minutes]))[0].id;
}
async function screening(ref='pcc:100',opts={}) {
  const movie=(await query('insert into public.movies(tmdb_id,match_status) values($1,$2) returning id',[opts.tmdb??348,opts.match??'matched']))[0].id;
  await query(`insert into public.screenings(cinema_name,source_reference,created_at,last_seen_at,start_time,movie_id,sold_out,active,booking_url)
    values($1,$2,coalesce($3::timestamptz,clock_timestamp()),$4::timestamptz-interval '9 minutes',$4::timestamptz+interval '2 days',$5,$6,$7,'https://cinema.example/book')`,
    [opts.cinema??'Prince Charles Cinema',ref,opts.created??null,now,movie,opts.soldOut??false,opts.active??true]);
  return movie;
}
async function detect(batch=500,clock=now){return rpc('screening_alerts_detect',[batch,clock]);}
before(async()=>{
 db=new PGlite();
 await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../manual-install/create_screening_alerts_stage1.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>{
 await db.exec(`reset role; truncate public.screening_alert_preferences,public.user_screening_alerts,
 private.screening_alert_items,private.screening_alert_dry_digests,private.screening_alert_dry_runs,
 private.screening_alert_performances,private.screening_alert_api_limits,public.screenings,public.movies,
 public.import_runs,auth.users cascade;
 update private.screening_alert_control set baseline_at=null,max_follows=200;
 insert into auth.users(id) values('${A}'),('${B}');`);
 now=(await query(`select ((clock_timestamp() at time zone 'Europe/London')::date+1+time '09:00') at time zone 'Europe/London' t`))[0].t;
 await rpc('screening_alerts_seed_baseline');
});
after(async()=>{await db.close();});
test('schema installs, email gates cannot be enabled, baseline cannot be reset',async()=>{
 assert.equal((await rpc('screening_alerts_report')).sending_enabled,false);
 await assert.rejects(db.query('update private.screening_alert_control set sending_enabled=true'),/check constraint/);
 await follows();
 await assert.rejects(db.query('update public.screening_alert_preferences set email_enabled=true'),/check constraint/);
 await assert.rejects(rpc('screening_alerts_seed_baseline'),/already seeded/);
});
test('preexisting and late-visible pre-installation performances remain baseline',async()=>{
 await follows();await run();
 await screening('pcc:old',{created:'2000-01-01T00:00:00Z'});
 // Numeric key required; old creation timestamp is deliberately discovered late.
 await query("update public.screenings set source_reference='pcc:1'");
 await detect();
 assert.equal((await query('select baseline from private.screening_alert_performances'))[0].baseline,true);
 assert.equal((await query('select count(*)::int n from private.screening_alert_items'))[0].n,0);
});
test('initial baseline seeds inactive and unmatched rows before any preview request',async()=>{
 await query('update private.screening_alert_control set baseline_at=null');
 await screening('pcc:7',{active:false,match:'unmatched'});
 const seed=await rpc('screening_alerts_seed_baseline');assert.equal(seed.seeded,1);
 await follows();await run();
 await db.exec("update public.screenings set active=true; update public.movies set match_status='matched'");
 await detect();assert.equal((await query('select count(*)::int n from private.screening_alert_items'))[0].n,0);
});
test('new exact film creates one item and one dry digest across repeated runs',async()=>{
 await follows();await run();await screening();
 const first=await detect(); assert.equal(first.digests_created,1);assert.equal(first.emails_sent,0);
 await detect();await detect();
 assert.equal((await query('select count(*)::int n from private.screening_alert_items'))[0].n,1);
 assert.equal((await query('select count(*)::int n from private.screening_alert_dry_digests'))[0].n,1);
 const read=await rpc('screening_alerts_read',[A]);assert.equal(read.email_permission,false);assert.equal(read.latest_preview.performances[0].tmdb_id,348);
});
test('title collisions cannot qualify another TMDB identity',async()=>{
 await follows(A,348,'Same title');await follows(B,999,'Same title');await run();await screening();await detect();
 assert.deepEqual((await query('select user_id from private.screening_alert_items')).map(r=>r.user_id),[A]);
});
test('several films and performances become one digest',async()=>{
 await follows();await follows(A,999,'Other film');await run();
 await screening('pcc:1');await screening('pcc:2');await screening('pcc:3',{tmdb:999});await detect();
 const d=(await query('select preview from private.screening_alert_dry_digests'))[0];assert.equal(d.preview.performances.length,3);
});
test('needs_review and candidate identity never create items',async()=>{
 await follows();await run();await screening('pcc:1',{match:'needs_review'});await detect();
 assert.equal((await query('select reason from private.screening_alert_performances'))[0].reason,'unconfirmed_film');
 assert.equal((await query('select count(*)::int n from private.screening_alert_items'))[0].n,0);
});
test('delayed confirmation of new post-request identity recovers',async()=>{
 await follows();await run();const movie=await screening('pcc:1',{match:'unmatched'});await detect();
 await query("update public.movies set match_status='matched' where id=$1",[movie]);
 assert.equal((await detect()).digests_created,1);
});
test('existing performance before follow does not become a catch-up item',async()=>{
 await run();await screening('pcc:1');
 await new Promise(r=>setTimeout(r,5));await follows();await detect();
 assert.equal((await query('select count(*)::int n from private.screening_alert_items'))[0].n,0);
});
for(const status of ['failed','running']) test(`${status} latest import holds partial data, then success recovers`,async()=>{
 await follows();await run('Prince Charles Cinema',status);await screening('pcc:1',{soldOut:true});await detect();
 let row=(await query('select state,reason,accepted_tmdb_id from private.screening_alert_performances'))[0];
 assert.equal(row.state,'pending');assert.equal(row.reason,'import_'+status);assert.equal(row.accepted_tmdb_id,null);
 await query("update public.import_runs set status='success'");await query('update public.screenings set sold_out=false');
 assert.equal((await detect()).digests_created,1);
});
test('stale or unseen successful source cannot qualify',async()=>{
 await follows();await run();await screening('pcc:1');
 await query("update public.screenings set last_seen_at=last_seen_at-interval '2 days'");await detect();
 assert.equal((await query('select reason from private.screening_alert_performances'))[0].reason,'not_seen_in_successful_run');
 await query("update public.import_runs set started_at=started_at-interval '3 days',completed_at=completed_at-interval '3 days'");await detect();
 assert.equal((await query('select reason from private.screening_alert_performances'))[0].reason,'source_stale');
});
test('five grouped venues resolve correct importer ownership',async()=>{
 await follows();await run('Electric Cinemas');await run('Olympic Cinemas');
 const cases=[['Electric Cinema Portobello','electric:portobello:1'],['Electric Cinema White City','electric:white-city:1'],
 ['The Cinema at Selfridges','olympic:selfridges:1'],['The Cinema in the Arches','olympic:arches:1'],['The Cinema in the Power Station','olympic:power-station:1']];
 for(const [cinema,ref] of cases)await screening(ref,{cinema});
 await detect();assert.equal((await query("select count(*)::int n from private.screening_alert_performances where reason='ready'"))[0].n,5);
});
test('group success does not refresh a venue preserved from an older run',async()=>{
 await follows();await run('Olympic Cinemas');await screening('olympic:arches:1',{cinema:'The Cinema in the Arches'});
 await query("update public.screenings set last_seen_at=last_seen_at-interval '1 day'");await detect();
 assert.equal((await query('select reason from private.screening_alert_performances'))[0].reason,'not_seen_in_successful_run');
});
for(const cinema of ['ICA Cinema','David Lean Cinema']) test(`${cinema} is explicitly excluded`,async()=>{
 await follows();await run(cinema);await screening(cinema==='ICA Cinema'?'ica:event:time:screen':'davidlean:title:day:time',{cinema});await detect();
 assert.equal((await query('select reason from private.screening_alert_performances'))[0].reason,'source_excluded');
});
test('unmapped and unapproved reference forms fail closed',async()=>{
 await follows();await run();await screening('pcc:title:time');await screening('unknown:1',{cinema:'New venue'});await detect();
 assert.deepEqual((await query('select reason from private.screening_alert_performances order by reason')).map(x=>x.reason),['reference_not_approved','source_unmapped']);
});
test('reimports, URL/time edits and deactivate/reactivate preserve one event',async()=>{
 await follows();await run();await screening();await detect();
 await query("update public.screenings set booking_url='https://new.example/book',start_time=start_time+interval '1 hour',active=false");await detect();
 await query('update public.screenings set active=true');await detect();
 assert.equal((await query('select count(*)::int n from private.screening_alert_items'))[0].n,1);
});
test('trusted sold-out exclusion is final through later availability changes',async()=>{
 await follows();await run();await screening('pcc:1',{soldOut:true});await detect();
 await query('update public.screenings set sold_out=false');await detect();
 assert.equal((await query('select reason from private.screening_alert_performances'))[0].reason,'sold_out');
 assert.equal((await query('select count(*)::int n from private.screening_alert_items'))[0].n,0);
});
test('unknown availability qualifies honestly, no tickets are promised',async()=>{
 await follows();await run();await screening();assert.equal((await detect()).digests_created,1);
});
test('changed confirmed film identity is quarantined without a second event',async()=>{
 await follows();await run();const id=await screening();await detect();
 await query('update public.movies set tmdb_id=999 where id=$1',[id]);await detect();
 assert.equal((await query('select reason from private.screening_alert_performances'))[0].reason,'film_identity_conflict');
 assert.equal((await query('select count(*)::int n from private.screening_alert_items'))[0].n,1);
});
test('delete/recreate same source reference retains first identity',async()=>{
 await follows();await run();await screening();await detect();
 const first=(await query('select first_created_at from private.screening_alert_performances'))[0].first_created_at;
 await query('delete from public.screenings');await screening();await detect();
 assert.equal((await query('select first_created_at from private.screening_alert_performances'))[0].first_created_at.toISOString(),first.toISOString());
 assert.equal((await query('select count(*)::int n from private.screening_alert_items'))[0].n,1);
});
test('remove/refollow and pause/resume cancel old generations',async()=>{
 await follows();await run();await screening();
 const early=(await query(`select (($1::timestamptz at time zone 'Europe/London')::date+time '13:00') at time zone 'Europe/London' t`,[now]))[0].t;
 await detect(500,early); // outside catch-up window, item remains unpreviewed
 await rpc('screening_alerts_request',[A,'remove',348]);await follows();await detect();
 assert.equal((await query('select state from private.screening_alert_items'))[0].state,'cancelled');
 await rpc('screening_alerts_request',[A,'pause']);await rpc('screening_alerts_request',[A,'resume']);await detect();
 assert.equal((await query('select state from private.screening_alert_items'))[0].state,'cancelled');
});
test('pause cancels pending previews and resume allows only genuinely new performances',async()=>{
 await follows();await run();await screening('pcc:1');
 const outside=new Date(now);outside.setUTCHours(15);
 await detect(500,outside);
 assert.equal((await query('select state from private.screening_alert_items'))[0].state,'preview_ready');
 await rpc('screening_alerts_request',[A,'pause']);
 assert.equal((await query('select state,reason from private.screening_alert_items'))[0].reason,'global_pause');
 await screening('pcc:2');await detect();
 assert.equal((await query('select count(*)::int n from private.screening_alert_items'))[0].n,1);
 await rpc('screening_alerts_request',[A,'resume']);await screening('pcc:3');await detect();
 const preview=(await rpc('screening_alerts_read',[A])).latest_preview;
 assert.deepEqual(preview.performances.map(x=>x.source_reference),['pcc:3']);
});
test('cinema identity changes quarantine an established source reference',async()=>{
 await follows();await run();await screening();await detect();
 await query("update public.screenings set cinema_name='Rio Cinema'");await detect();
 const p=(await query('select state,reason from private.screening_alert_performances'))[0];
 assert.equal(p.state,'quarantined');assert.equal(p.reason,'cinema_identity_conflict');
});
test('digest rechecks ready items even outside the current evaluation batch',async()=>{
 await follows();await run();const first=await screening('pcc:1');const second=await screening('pcc:2');
 const outside=new Date(now);outside.setUTCHours(15);await detect(500,outside);
 await query('update public.movies set tmdb_id=999 where id=$1',[second]);
 await query("update private.screening_alert_performances set last_evaluated_at=null where source_reference='pcc:1'");
 await detect(1);
 const preview=(await rpc('screening_alerts_read',[A])).latest_preview;
 assert.deepEqual(preview.performances.map(x=>x.source_reference),['pcc:1']);
});
test('follow repeat is idempotent, follow limits apply to active films',async()=>{
 await follows();const first=(await query('select effective_at,generation from public.user_screening_alerts'))[0];await follows();
 assert.deepEqual((await query('select effective_at,generation from public.user_screening_alerts'))[0],first);
 await query('update private.screening_alert_control set max_follows=1');await assert.rejects(follows(A,999),/limit/);
});
test('two-account RLS reads isolate rows and direct browser mutations/RPCs are denied',async()=>{
 await follows();await follows(B,999,'Other');
 await db.exec(`set role authenticated; set request.jwt.claim.sub='${A}';`);
 try {
  assert.deepEqual((await query('select user_id from public.user_screening_alerts')).map(x=>x.user_id),[A]);
  assert.equal((await query('select * from public.user_screening_alerts where user_id=$1',[B])).length,0);
  await assert.rejects(query('delete from public.user_screening_alerts'),/permission denied/);
  await assert.rejects(query('update public.user_screening_alerts set active=false'),/permission denied/);
  await assert.rejects(query('insert into public.user_screening_alerts(user_id,tmdb_id,display_title) values($1,9999,\'Spoof\')',[B]),/permission denied/);
  await assert.rejects(query('update public.screening_alert_preferences set paused=true'),/permission denied/);
  assert.deepEqual((await query('select user_id from public.screening_alert_preferences')).map(x=>x.user_id),[A]);
  await assert.rejects(rpc('screening_alerts_read',[B]),/permission denied/);
  await assert.rejects(query('select * from private.screening_alert_items'),/permission denied/);
 } finally {await db.exec('reset role');}
});
test('service invoker RPCs work without exposing auth.users',async()=>{
 await db.exec('set role service_role');
 try {await follows();assert.equal((await detect()).emails_sent,0);} finally {await db.exec('reset role');}
});
test('account deletion cascades personal requests, items and previews',async()=>{
 await follows();await run();await screening();await detect();
 await rpc('screening_alerts_budget',[A,'read']);await query('delete from auth.users where id=$1',[A]);
 for(const table of ['public.user_screening_alerts','public.screening_alert_preferences','private.screening_alert_items','private.screening_alert_dry_digests'])
  assert.equal((await query(`select count(*)::int n from ${table}`))[0].n,0);
 assert.equal((await query('select count(*)::int n from private.screening_alert_performances'))[0].n,1);
 assert.equal((await query('select count(*)::int n from private.screening_alert_api_limits where user_id=$1',[A]))[0].n,0);
});
test('batch limits bound collection and evaluation; retries finish remaining rows',async()=>{
 await follows();await run();for(let i=1;i<=4;i++)await screening('pcc:'+i);
 let r=await detect(2);assert.equal(r.collected,2);assert.equal(r.evaluated,2);
 r=await detect(2);assert.equal(r.collected,2);
 assert.equal((await query('select count(*)::int n from private.screening_alert_performances'))[0].n,4);
 await assert.rejects(detect(null),/Batch size/);await assert.rejects(detect(1001),/Batch size/);
});
test('durable API quotas cannot be bypassed by repeated calls',async()=>{
 for(let i=0;i<30;i++) assert.equal((await rpc('screening_alerts_budget',[A,'search'])).allowed,true);
 assert.equal((await rpc('screening_alerts_budget',[A,'search'])).allowed,false);
});
test('London DST digest window uses local time, outside catch-up window holds',async()=>{
 await follows();await run();await screening();
 const after=(await query(`select (($1::timestamptz at time zone 'Europe/London')::date+time '13:00') at time zone 'Europe/London' t`,[now]))[0].t;
 assert.equal((await detect(500,after)).digests_created,0);
 assert.equal((await query("select ('2026-10-24T07:00Z'::timestamptz at time zone 'Europe/London')::time as summer,('2026-10-26T08:00Z'::timestamptz at time zone 'Europe/London')::time as winter"))[0].summer,'08:00:00');
 assert.equal((await detect()).digests_created,1);
});
