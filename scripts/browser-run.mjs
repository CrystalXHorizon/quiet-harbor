import {spawn} from 'node:child_process';
const base='http://127.0.0.1:4177';
function run(args,env=process.env){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{env,stdio:'inherit'});child.once('exit',code=>code===0?resolve():reject(new Error(args.join(' ')+' exited '+code)));child.once('error',reject);});}
// Fixtures use a single fixed origin, so the browser exercises the real scoped CSP.
await run(['scripts/build.mjs'],{...process.env,PUBLIC_SUPABASE_URL:'https://quiet-harbor-qa.supabase.co',PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_browser_qa_fixture'});
const server=spawn(process.execPath,['scripts/preview.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'4177'},stdio:['ignore','pipe','inherit']});
try{
 await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',()=>reject(new Error('Preview failed to start')));server.once('error',reject);});
 await run(['scripts/browser-check.cjs',base]);
 await run(['scripts/browser-audit.cjs',base]);
 await run(['scripts/browser-theme.cjs',base]);
}finally{server.kill();await run(['scripts/build.mjs']);}
