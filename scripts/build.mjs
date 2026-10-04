import {build} from 'esbuild';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {validateSiteConfig} from '../public/backend-client.js';
import {contentSecurity} from '../public/content-security.js';

const target=resolve('dist');
await mkdir(target,{recursive:true});
const files=['index.html','community-rules.html','community-rules.css','style.css','theme.css','theme.js','favicon.svg','app.js','safety.js','strategies.js','providers.js','community.js','community.css','personal.js','personal.css','chat-state.js','form-validation.js'];
for(const file of files)await copyFile(resolve('public',file),resolve(target,file));
const config=JSON.parse(await readFile('public/site-config.json','utf8'));
if(process.env.PUBLIC_SUPABASE_URL)config.supabaseUrl=process.env.PUBLIC_SUPABASE_URL;
if(process.env.PUBLIC_SUPABASE_ANON_KEY)config.supabaseAnonKey=process.env.PUBLIC_SUPABASE_ANON_KEY;
if(Boolean(config.supabaseUrl)!==Boolean(config.supabaseAnonKey))throw new Error('PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY must both be set, or both be empty');
if(config.supabaseUrl)Object.assign(config,validateSiteConfig(config));
await writeFile(resolve(target,'site-config.json'),JSON.stringify(config,null,2)+'\n');
await build({entryPoints:['public/auth-panel.js'],outfile:resolve(target,'auth-bundle.js'),bundle:true,format:'esm',platform:'browser',target:['es2022'],minify:true,legalComments:'linked'});
// GitHub Pages caches stable asset URLs. Version both the entry and its auth
// dependency so a fresh page cannot keep running an older recovery flow.
const digest=content=>createHash('sha256').update(content).digest('hex').slice(0,16);
const versions=new Map(),visiting=new Set();
async function versionModule(file){
 if(versions.has(file))return versions.get(file);
 if(visiting.has(file))throw new Error('Cyclic browser module graph: '+file);
 visiting.add(file);
 let source=await readFile(resolve(target,file),'utf8');
 const imports=[...source.matchAll(/(['"])\.\/([a-z0-9-]+\.js)\1/g)];
 for(const [,mark,dependency] of imports){const version=await versionModule(dependency);source=source.replaceAll(`${mark}./${dependency}${mark}`,`${mark}./${dependency}?v=${version}${mark}`);}
 await writeFile(resolve(target,file),source);
 const version=digest(source);versions.set(file,version);visiting.delete(file);return version;
}
await versionModule('app.js');
const appSource=await readFile(resolve(target,'app.js'),'utf8');
let page=(await readFile(resolve(target,'index.html'),'utf8')).replace('src="./app.js"',`src="./app.js?v=${digest(appSource)}"`);
const csp=contentSecurity(config);
page=page.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]+(">)/,(_,prefix,suffix)=>prefix+csp+suffix);
await writeFile(resolve(target,'security-headers.json'),JSON.stringify({'Content-Security-Policy':csp+"; frame-ancestors 'none'",'X-Frame-Options':'DENY'},null,2)+'\n');
// Header-capable static hosts can consume _headers; GitHub Pages ignores it.
await writeFile(resolve(target,'_headers'),`/*\n  Content-Security-Policy: ${csp}; frame-ancestors 'none'\n  X-Frame-Options: DENY\n`);
for(const css of ['style.css','community.css','personal.css','theme.css'])page=page.replace(`href="./${css}"`,`href="./${css}?v=${digest(await readFile(resolve(target,css)))}"`);
const themeVersion=digest(await readFile(resolve(target,'theme.js')));
page=page.replace('src="./theme.js"',`src="./theme.js?v=${themeVersion}"`);
await writeFile(resolve(target,'index.html'),page);
const rules=(await readFile(resolve(target,'community-rules.html'),'utf8')).replace('href="./community-rules.css"',`href="./community-rules.css?v=${digest(await readFile(resolve(target,'community-rules.css')))}"`);
await writeFile(resolve(target,'community-rules.html'),rules.replace('src="./theme.js"',`src="./theme.js?v=${themeVersion}"`).replace('href="./theme.css"',`href="./theme.css?v=${digest(await readFile(resolve(target,'theme.css')))}"`));
console.log(config.supabaseUrl?'Built configured frontend in dist/':'Built frontend in dist/ (backend not configured; local preview only)');
