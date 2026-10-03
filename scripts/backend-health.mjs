import {writeFile} from 'node:fs/promises';
const response=await fetch(process.env.PUBLIC_SUPABASE_URL+'/functions/v1/api/health',{headers:{Origin:process.env.PUBLIC_SITE_ORIGIN||'https://crystalxhorizon.github.io'},signal:AbortSignal.timeout(30000)});
const result=await response.json();
if(!response.ok||!result.ok||result.schema!=='202610030004'||result.commit!==process.env.GITHUB_SHA)throw new Error('Backend deployment health/version mismatch');
await writeFile('backend-deployment.json',JSON.stringify({...result,checkedAt:new Date().toISOString()},null,2)+'\n');
console.log('Backend schema and deployed commit verified');
