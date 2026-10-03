import test from 'node:test';
import assert from 'node:assert/strict';
test('the actual Deno entry wires environment values and registers a working handler',async()=>{
 const previousDeno=globalThis.Deno,previousFetch=globalThis.fetch;
 const env={SUPABASE_URL:'https://entry.supabase.co',SUPABASE_ANON_KEY:'anon-fixture',SUPABASE_SERVICE_ROLE_KEY:'service-fixture',ALLOWED_ORIGINS:'https://site.example'};
 let handler;
 try{
  globalThis.fetch=async(url,o)=>{assert.equal(url,'https://entry.supabase.co/rest/v1/rpc/qh_backend_version');assert.equal(o.headers.apikey,'service-fixture');return Response.json({schema:'202610030004'});};
  globalThis.Deno={env:{get:key=>env[key]},serve:value=>{handler=value;}};
  await import('../supabase/functions/api/index.ts');
  assert.equal(typeof handler,'function');
  const health=await handler(new Request('https://entry.supabase.co/functions/v1/api/health',{headers:{Origin:'https://site.example'}}));assert.equal(health.status,200);assert.equal((await health.json()).schema,'202610030004');
 }finally{globalThis.fetch=previousFetch;if(previousDeno===undefined)delete globalThis.Deno;else globalThis.Deno=previousDeno;}
});
