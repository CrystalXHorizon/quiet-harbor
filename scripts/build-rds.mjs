import {build} from 'esbuild';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
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
const migrations=(await readdir('supabase/migrations')).filter(name=>name.endsWith('.sql')).sort();
await writeFile(resolve(target,'quiet-harbor.sql'),(await Promise.all(migrations.map(name=>readFile(resolve('supabase/migrations',name),'utf8')))).join('\n\n'));
console.log('RDS deployment files ready in .supabase/rds-deploy (no credentials included)');
