import {build} from 'esbuild';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const target=resolve('dist');
await mkdir(target,{recursive:true});
const files=['index.html','style.css','favicon.svg','app.js','safety.js','strategies.js','providers.js','community.js','community.css'];
for(const file of files)await copyFile(resolve('public',file),resolve(target,file));
const config=JSON.parse(await readFile('public/site-config.json','utf8'));
if(process.env.PUBLIC_SUPABASE_URL)config.supabaseUrl=process.env.PUBLIC_SUPABASE_URL;
if(process.env.PUBLIC_SUPABASE_ANON_KEY)config.supabaseAnonKey=process.env.PUBLIC_SUPABASE_ANON_KEY;
if(process.env.PUBLIC_INVITE_ONLY)config.inviteOnly=process.env.PUBLIC_INVITE_ONLY!=='false';
if(config.supabaseUrl||config.supabaseAnonKey){
  const url=new URL(config.supabaseUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('PUBLIC_SUPABASE_URL must be an HTTPS project origin');
  if(config.supabaseAnonKey.startsWith('sb_secret_'))throw new Error('A backend secret must never be bundled into the browser');
  if(config.supabaseAnonKey.includes('.')){
    const claims=JSON.parse(Buffer.from(config.supabaseAnonKey.split('.')[1],'base64url').toString());
    if(claims.role!=='anon')throw new Error('Only a Supabase anon/publishable key may be public');
  }else if(!config.supabaseAnonKey.startsWith('sb_publishable_'))throw new Error('Use a Supabase publishable/anon key, never an AI key');
}
await writeFile(resolve(target,'site-config.json'),JSON.stringify(config,null,2)+'\n');
await build({entryPoints:['public/auth-panel.js'],outfile:resolve(target,'auth-bundle.js'),bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'linked'});
// GitHub Pages caches stable asset URLs. Version both the entry and its auth
// dependency so a fresh page cannot keep running an older recovery flow.
const digest=content=>createHash('sha256').update(content).digest('hex').slice(0,16);
const authVersion=digest(await readFile(resolve(target,'auth-bundle.js')));
const communityVersion=digest(await readFile(resolve(target,'community.js')));
const appSource=(await readFile(resolve(target,'app.js'),'utf8')).replace("'./auth-bundle.js'",`'./auth-bundle.js?v=${authVersion}'`).replace("'./community.js'",`'./community.js?v=${communityVersion}'`);
await writeFile(resolve(target,'app.js'),appSource);
let page=(await readFile(resolve(target,'index.html'),'utf8')).replace('src="./app.js"',`src="./app.js?v=${digest(appSource)}"`);
for(const css of ['style.css','community.css'])page=page.replace(`href="./${css}"`,`href="./${css}?v=${digest(await readFile(resolve(target,css)))}"`);
await writeFile(resolve(target,'index.html'),page);
console.log(config.supabaseUrl?'Built configured frontend in dist/':'Built frontend in dist/ (backend not configured; local preview only)');
