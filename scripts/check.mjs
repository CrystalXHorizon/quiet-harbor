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
await Promise.all(['public','scripts','supabase/functions'].map(check));
const app=await readFile('public/app.js','utf8');
if(/runHarness|providerEnv|AI_API_KEY|verifyKey/.test(app))throw new Error('The browser chat path must only call the authenticated backend');
console.log('JavaScript syntax and backend-only chat path checked');
