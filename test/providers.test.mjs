import test from 'node:test';
import assert from 'node:assert/strict';
import {PROVIDERS,normalizeConfig,providerEnv,packConnection,unpackConnection} from '../public/providers.js';
import {complete,verifyKey,listModels,runHarness} from '../public/harness.js';
import {encryptKey,decryptKey} from '../public/vault.js';
const config=id=>normalizeConfig({...PROVIDERS.find(p=>p.id===id),provider:id,model:'test-model'});
test('all presets build HTTPS endpoints, custom URLs normalize and reject embedded credentials',()=>{
 for(const p of PROVIDERS.filter(p=>p.id!=='custom'))assert.match(providerEnv(config(p.id),'fake').AI_ENDPOINT,/^https:\/\//);
 const c=config('openai');assert.equal(normalizeConfig({...c,base:c.base+'/chat/completions/'}).base,c.base);
 for(const base of ['http://example.com/v1','https://user:pass@example.com/v1','https://example.com/v1?key=secret','https://example.com/v1#secret'])assert.throws(()=>normalizeConfig({...c,base}));
});
test('Anthropic protocol keeps system separate, uses native auth and requires end_turn',async()=>{
 let request;const env=providerEnv(config('anthropic'),'fake');
 assert.deepEqual(await complete(env,[{role:'system',content:'Rules'},{role:'user',content:'Hi'}],{json:true,fetchImpl:async(url,options)=>{request={url:String(url),...options};return Response.json({stop_reason:'end_turn',content:[{type:'text',text:'{"ok":true}'}]});}}),{ok:true});
 const body=JSON.parse(request.body);assert.equal(body.system,'Rules');assert.deepEqual(body.messages,[{role:'user',content:'Hi'}]);assert.equal(request.headers['x-api-key'],'fake');assert.equal(request.headers.Authorization,undefined);assert.equal(body.response_format,undefined);
 await assert.rejects(complete(env,[],{fetchImpl:async()=>Response.json({stop_reason:'max_tokens',content:[{type:'text',text:'partial'}]})}));
});
test('custom provider used in all three harness stages; no DeepSeek-only parameters',async()=>{
 const env=providerEnv({...config('openai'),provider:'custom',base:'https://example.com/v1'},'fake');let calls=0;
 const answers=['{"route":"support"}','听起来今天很累。','{"safe":true}'];
 const result=await runHarness([{role:'user',content:'今天好累'}],env,{fetchImpl:async(url,o)=>{assert.equal(String(url),'https://example.com/v1/chat/completions');const body=JSON.parse(o.body);assert.equal(body.model,'test-model');assert.equal(body.thinking,undefined);assert.equal(body.response_format,undefined);assert.ok(body.max_completion_tokens);calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:answers.shift()}}]});}});
 assert.equal(calls,3);assert.equal(result.mode,'ai');
});
test('connection probe contains no history, handles model lists and CORS without leaking upstream body',async()=>{
 const env=providerEnv(config('gemini'),'fake');
 await verifyKey('fake',{env,fetchImpl:async(url,o)=>{assert.equal(JSON.parse(o.body).messages.length,2);assert.equal(o.redirect,'error');return Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]});}});
 assert.deepEqual(await listModels(env,{fetchImpl:async()=>Response.json({data:[{id:'a'},{id:'a'},{id:'b'}]})}),['a','b']);
 await assert.rejects(verifyKey('fake',{env,fetchImpl:async()=>{throw new TypeError('private');}}),/CORS/);
});
test('encrypted connection restores destination together with key, legacy DeepSeek keys still unlock',async()=>{
 const c={...config('openai'),provider:'custom',base:'https://example.com/v1'};
 const password='test password twelve';const record=await encryptKey(packConnection(c,'fake-key'),password);
 assert.ok(!JSON.stringify(record).includes('example.com'));
 assert.deepEqual(unpackConnection(await decryptKey(record,password)),{config:normalizeConfig(c),key:'fake-key'});
 assert.equal(unpackConnection('legacy-key').config.provider,'deepseek');
});
