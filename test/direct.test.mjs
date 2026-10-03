import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyKey, runHarness, DEFAULT_MODEL } from '../supabase/functions/_shared/harness.js';
test('direct key validation only sends authorization to official endpoint',async()=>{
  let request;
  assert.equal(await verifyKey('test-only',{fetchImpl:async(url,options)=>{request={url,options};return Response.json({data:[{id:DEFAULT_MODEL}]});}}),true);
  assert.equal(request.url,'https://api.deepseek.com/models');assert.equal(request.options.credentials,'omit');assert.equal(request.options.redirect,'error');assert.equal(request.options.headers.Authorization,'Bearer test-only');assert.equal(request.options.body,undefined);
});
test('direct connection rejects invalid keys and missing model',async()=>{
  await assert.rejects(verifyKey('fake',{fetchImpl:async()=>new Response('',{status:401})}),/Key 无效/);
  await assert.rejects(verifyKey('fake',{fetchImpl:async()=>Response.json({data:[]})}),/模型/);
});
test('direct harness exposes actionable errors without raw provider body',async()=>{
  await assert.rejects(runHarness([{role:'user',content:'hi'}],{AI_API_KEY:'fake'},{reportErrors:true,fetchImpl:async()=>new Response('private upstream data',{status:402})}),/余额不足/);
});
test('browser chat only uses authenticated backend and exposes no vendor-key settings',async()=>{
  const js=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(js,/runHarness|providerEnv|AI_API_KEY|verifyKey|encryptKey|decryptKey/);
  assert.match(js,/backend\.api\('chat'/);
  assert.doesNotMatch(html,/id="api-key"|id="access-token"|id="vault-password"/);
  assert.match(html,/id="auth-dialog"/);
});
