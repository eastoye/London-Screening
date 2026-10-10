import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
const db=new PGlite();
await db.exec(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../manual-install/create_screening_alerts_stage1.sql',import.meta.url),'utf8'));
console.log('Stage 1 SQL installed in local PostgreSQL', (await db.query('select version()')).rows[0]);
console.log((await db.query('select public.screening_alerts_seed_baseline()')).rows);
console.log((await db.query('select public.screening_alerts_detect()')).rows);
await db.close();
