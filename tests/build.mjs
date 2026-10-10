import {build} from 'esbuild';
await build({entryPoints:['supabase/functions/screening-alerts/index.ts','supabase/functions/process-screening-alerts/index.ts'],
  outdir:'.validation-build',bundle:true,format:'esm',platform:'neutral',target:'es2022'});
console.log('Both Stage 1 Edge Functions bundled successfully.');
