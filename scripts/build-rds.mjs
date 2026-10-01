import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Keep deployment artifacts outside dist/, which is published to GitHub Pages.
const target=resolve('.supabase/rds-deploy');
await mkdir(target,{recursive:true});
await build({
 entryPoints:['supabase/functions/api/index.ts'],
 outfile:resolve(target,'api.ts'),
 bundle:true,format:'esm',platform:'neutral',target:['es2022'],
 minify:false,legalComments:'inline'
});
await copyFile('supabase/migrations/202610010001_quiet_harbor.sql',resolve(target,'quiet-harbor.sql'));
console.log('RDS deployment files ready in .supabase/rds-deploy (no credentials included)');
