import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
async function check(dir){
 for(const entry of await readdir(dir,{withFileTypes:true})){
  const path=dir+'/'+entry.name;
  if(entry.isDirectory())await check(path);
  else if(/\.(js|mjs|cjs|ts)$/.test(entry.name)){
   const result=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});
   if(result.status!==0)process.exit(result.status||1);
  }
 }
}
await Promise.all(['public','scripts','supabase/functions','test'].map(check));
const root=spawnSync(process.execPath,['--check','harness.mjs'],{stdio:'inherit'});
if(root.status!==0)process.exit(root.status||1);
for(const file of (await readdir('public')).filter(f=>f.endsWith('.js'))){
 const source=await readFile('public/'+file,'utf8');
 if(/runHarness|providerEnv|AI_API_KEY|verifyKey/.test(source))throw new Error(file+': browser modules must only call the authenticated backend');
}
console.log('JavaScript syntax and backend-only chat path checked');
