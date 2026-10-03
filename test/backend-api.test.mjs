import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiHandler} from '../supabase/functions/_shared/api.js';
import {resolveSupabaseKeys} from '../supabase/functions/_shared/supabase-keys.js';
import {safeProviderConfig,encryptKey,decryptKey,validateAction,allowedOrigins} from '../supabase/functions/_shared/security.js';

const userId='22222222-2222-4222-8222-222222222222';
const origin='https://crystalxhorizon.github.io';
const master=Buffer.alloc(32,8).toString('base64');
const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'public-key',SUPABASE_SERVICE_ROLE_KEY:'private-service',ALLOWED_ORIGINS:origin,AI_ENCRYPTION_KEY:master};
const config=safeProviderConfig({provider:'deepseek',base:'https://api.deepseek.com',protocol:'openai',model:'test-model',jsonMode:true});
const token=(aal='aal1')=>'header.'+Buffer.from(JSON.stringify({sub:userId,aal})).toString('base64url')+'.signature';
const user={id:userId,email_confirmed_at:'2026-10-01T00:00:00Z'};
const request=(body,aal='aal1',headers={})=>new Request('https://example.supabase.co/functions/v1/api',{method:'POST',headers:{origin,authorization:'Bearer '+token(aal),'content-type':'application/json',...headers},body:JSON.stringify(body)});
const json=(value,status=200)=>Response.json(value,{status});
function mockHandler(handle){const calls=[];return {calls,handler:createApiHandler({env,fetchImpl:async(url,options)=>{const c={url:String(url),...options};calls.push(c);if(c.url.endsWith('/auth/v1/user'))return json(user);return handle(c);}})};}

test('Supabase default key dictionaries and legacy environments both validate users before service RPC',async()=>{
 const modern={SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:'sb_publishable_test'}),SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_test'})};
 const cases=[
  {variables:env,publishable:'public-key',secret:'private-service'},
  {variables:{...env,SUPABASE_ANON_KEY:undefined,SUPABASE_SERVICE_ROLE_KEY:undefined,...modern},publishable:'sb_publishable_test',secret:'sb_secret_test'},
  {variables:{...env,...modern},publishable:'sb_publishable_test',secret:'sb_secret_test'},
  {variables:{...env,SUPABASE_PUBLISHABLE_KEYS:modern.SUPABASE_PUBLISHABLE_KEYS},publishable:'sb_publishable_test',secret:'private-service'},
  {variables:{...env,SUPABASE_SECRET_KEYS:modern.SUPABASE_SECRET_KEYS},publishable:'public-key',secret:'sb_secret_test'}
 ];
 for(const {variables,publishable,secret} of cases){
  const calls=[];
  const handler=createApiHandler({env:variables,fetchImpl:async(url,options)=>{
   calls.push(String(url));
   if(calls.length===1){
    assert.equal(String(url),env.SUPABASE_URL+'/auth/v1/user');
    assert.equal(options.headers.apikey,publishable);
    assert.equal(options.headers.Authorization,'Bearer '+token());
    return json(user);
   }
   assert.equal(String(url),env.SUPABASE_URL+'/rest/v1/rpc/qh_action');
   assert.equal(options.headers.apikey,secret);
   assert.equal(options.headers.Authorization,secret.startsWith('sb_secret_')?undefined:'Bearer '+secret);
   assert.equal(JSON.parse(options.body).actor,userId);
   return json({profile:{id:userId,role:'member'}});
  }});
  const response=await handler(request({action:'me'}));
  assert.equal(response.status,200);assert.equal(calls.length,2);
  assert.ok(!(await response.text()).includes(secret));
 }
});

test('missing or malformed default key dictionaries fail closed or fall back to legacy keys',async()=>{
 const invalid=[undefined,'','not-json','null','[]','{}','{"other":"sb_secret_other"}','{"default":null}','{"default":123}','{"default":""}','{"default":"sb_secret_"}','{"default":"sb_secret_has space"}','{"default":"sb_publishable_wrong_role"}'];
 for(const raw of invalid){
  const variables={...env,SUPABASE_PUBLISHABLE_KEYS:raw,SUPABASE_SECRET_KEYS:raw};
  const resolved=resolveSupabaseKeys(variables);
  assert.equal(resolved.secretKey,'private-service');
  // Even a valid publishable dictionary can never be selected as the secret key.
  assert.equal(resolved.publishableKey,raw==='{"default":"sb_publishable_wrong_role"}'?'sb_publishable_wrong_role':'public-key');
  let calls=0;
  const handler=createApiHandler({env:{...variables,SUPABASE_ANON_KEY:undefined,SUPABASE_SERVICE_ROLE_KEY:undefined},fetchImpl:async()=>{calls++;return json(user);}});
  const response=await handler(request({action:'me'}));
  assert.equal(response.status,503);assert.equal((await response.json()).code,'not_configured');
  assert.equal(calls,raw==='{"default":"sb_publishable_wrong_role"}'?1:0);
 }
});

test('API rejects foreign origin, missing auth and invalid method before touching any service',async()=>{
 const {handler,calls}=mockHandler(()=>{throw new Error('Unexpected');});
 assert.equal((await handler(request({action:'me'},'aal1',{origin:'https://attacker.invalid'}))).status,403);
 assert.equal((await handler(request({action:'me'},'aal1',{authorization:''}))).status,401);
 assert.equal((await handler(new Request('https://example.supabase.co/api',{headers:{origin}}))).status,405);
 assert.equal(calls.length,0);
 const options=await handler(new Request('https://example.supabase.co/api',{method:'OPTIONS',headers:{origin}}));
 assert.equal(options.status,204);assert.equal(options.headers.get('access-control-allow-origin'),origin);
 assert.equal(allowedOrigins(origin+',*,https://example.com/').size,1);
});
test('an unverified token cannot manufacture identity or aal2',async()=>{
 const calls=[];const handler=createApiHandler({env,fetchImpl:async(url)=>{calls.push(String(url));return json({error:'invalid'},401);}});
 const res=await handler(request({action:'admin.ai.get',actor:'11111111-1111-4111-8111-111111111111'},'aal2'));
 assert.equal(res.status,401);assert.equal(calls.length,1);assert.match(calls[0],/auth\/v1\/user$/);
});
test('verified TOTP enrollment protects all application data until Auth has issued aal2',async()=>{
 const factors=[{id:'factor-id',factor_type:'totp',status:'verified'}];
 for(const action of ['me','posts.list','admin.queue','chat']){
  const calls=[];
  const handler=createApiHandler({env,fetchImpl:async(url)=>{calls.push(String(url));return json({...user,factors});}});
  const res=await handler(request({action,factors:[],aal2:true,messages:[{role:'user',content:'hello'}]}));
  assert.equal(res.status,403);assert.equal((await res.json()).code,'mfa_required');
  assert.equal(calls.length,1);assert.match(calls[0],/auth\/v1\/user$/);
 }
 for(const [factors,aal] of [[[{factor_type:'totp',status:'unverified'}],'aal1'],[[],'aal1'],[[{factor_type:'totp',status:'verified'}],'aal2']]){
  let rpcCalled=false;
  const handler=createApiHandler({env,fetchImpl:async(url,options)=>{
   if(String(url).endsWith('/auth/v1/user'))return json({...user,factors,user_metadata:{factors:[{factor_type:'totp',status:'verified'}]}});
   rpcCalled=true;assert.equal(JSON.parse(options.body).aal2,aal==='aal2');return json({profile:{id:userId}});
  }});
  assert.equal((await handler(request({action:'me'},aal))).status,200);assert.ok(rpcCalled);
 }
});
test('RPC actor comes from verified Auth and privilege claims cannot be supplied as JSON',async()=>{
 const {handler}=mockHandler(c=>{
  assert.match(c.url,/rpc\/qh_action$/);const p=JSON.parse(c.body);
  assert.equal(p.actor,userId);assert.equal(p.aal2,false);assert.equal(p.payload.actor,undefined);assert.equal(p.payload.aal2,undefined);assert.equal(p.payload.encrypted_key,undefined);
  return json({profile:{id:userId,role:'member',status:'active'},ai:{ready:false,model:null},usage:{used:0,limit:30}});
 });
 const response=await handler(request({action:'me',actor:'11111111-1111-4111-8111-111111111111',aal2:true,encrypted_key:'injected'}));
 assert.equal(response.status,200);assert.equal((await response.json()).profile.id,userId);
});
test('body, message and action input bounds reject before privileged RPC',async()=>{
 const {handler,calls}=mockHandler(()=>{throw new Error('Unexpected');});
 assert.equal((await handler(request({action:'chat',messages:[{role:'user',content:'x'.repeat(4001)}]}))).status,400);
 assert.equal((await handler(request({action:'me',extra:'x'.repeat(73000)}))).status,413);
 assert.equal((await handler(request({action:'qh_reserve_ai'}))).status,400);
 assert.ok(calls.every(c=>c.url.endsWith('/auth/v1/user')));
 assert.throws(()=>validateAction({action:'reports.create',reason:'a'}));
 assert.throws(()=>validateAction({action:'posts.save',title:'x',body:'x',category:'share',preference:'listen',submit:'true'}));
});
test('provider allowlist rejects arbitrary hosts, raw IPs, unsafe URL components, and redirects stay disabled',()=>{
 const input={provider:'custom',base:'https://provider.example.com/v1',protocol:'openai',model:'test'};
 assert.throws(()=>safeProviderConfig(input));
 assert.equal(safeProviderConfig(input,'provider.example.com').base,input.base);
 for(const base of ['https://127.0.0.1/v1','https://localhost/v1','https://api.local/v1','https://provider.example.com:444/v1','http://provider.example.com/v1','https://a:b@provider.example.com/v1','https://provider.example.com/v1?key=x'])assert.throws(()=>safeProviderConfig({...input,base},'provider.example.com,127.0.0.1,localhost,api.local'));
});
test('server keys encrypt with distinct random IVs and are bound to endpoint/protocol',async()=>{
 const key='secret-for-test-only';const a=await encryptKey(key,master,config);const b=await encryptKey(key,master,config);
 assert.notEqual(a.iv,b.iv);assert.ok(!JSON.stringify(a).includes(key));assert.equal(await decryptKey(a,master,config),key);
 await assert.rejects(()=>decryptKey(a,Buffer.alloc(32,9).toString('base64'),config));
 await assert.rejects(()=>decryptKey(a,master,{...config,base:'https://api.openai.com/v1'}));
 await assert.rejects(()=>decryptKey({...a,data:a.data.slice(0,-3)+'AAAA'},master,config));
});
test('AI save requires MFA and sends only encrypted key to database',async()=>{
 let saved;const {handler,calls}=mockHandler(c=>{
  if(c.url.includes('qh_ai_settings?'))return json([{config:{},encrypted_key:null,enabled:false}]);
  const p=JSON.parse(c.body);if(p.action==='admin.ai.get')return json({config:null,key_set:false});
  assert.equal(p.action,'admin.ai.save');saved=p.payload;assert.equal(p.aal2,true);return json({ok:true});
 });
 const body={action:'admin.ai.save',config,key:'secret-for-test-only',enabled:true,user_daily_limit:30,global_daily_limit:300,encrypted_key:{injected:true},key_last4:'oops'};
 const rejected=await handler(request(body));assert.equal(rejected.status,403);assert.equal((await rejected.json()).code,'mfa_required');
 assert.equal(calls.some(c=>c.url.includes('qh_ai_settings?')),false);
 const accepted=await handler(request(body,'aal2'));assert.equal(accepted.status,200);
 assert.equal(await decryptKey(saved.encrypted_key,master,config),body.key);assert.equal(saved.key,undefined);assert.equal(saved.key_last4,'only');
 assert.ok(!JSON.stringify(await accepted.json()).includes(body.key));
 for(const c of calls){assert.equal(c.redirect,'error');if(c.url.includes('/rest/'))assert.ok(!c.body?.includes(body.key));}
});
test('an existing key cannot be silently sent to a different configured provider',async()=>{
 const encrypted_key=await encryptKey('secret-for-test-only',master,config);
 const {handler,calls}=mockHandler(c=>c.url.includes('qh_ai_settings?')?json([{config,encrypted_key}]):json({key_set:true}));
 const res=await handler(request({action:'admin.ai.test',config:{...config,base:'https://api.openai.com/v1',provider:'openai'}},'aal2'));
 assert.equal(res.status,400);assert.equal((await res.json()).code,'key_required');assert.ok(calls.every(c=>c.url.startsWith(env.SUPABASE_URL)));
});
test('chat uses only server config and reserves quota before three-stage harness calls',async()=>{
 const secret='server-secret-only';const encrypted_key=await encryptKey(secret,master,config);let stage=0;let reserved=false;
 const outputs=[{route:'support',mode:'listen'},'你可以接着说，我会跟着你说的内容聊。',{safe:true}];
 const {handler,calls}=mockHandler(c=>{
  if(c.url.endsWith('/rpc/qh_action'))return json({profile:{status:'active',admission_status:'approved'}});
  if(c.url.endsWith('/rpc/qh_reserve_ai')){reserved=true;assert.equal(JSON.parse(c.body).actor,userId);return json({config,encrypted_key});}
  assert.ok(reserved);assert.equal(c.url,'https://api.deepseek.com/chat/completions');assert.equal(c.headers.Authorization,'Bearer '+secret);assert.equal(c.redirect,'error');
  const output=outputs[stage++];return json({choices:[{finish_reason:'stop',message:{content:typeof output==='string'?output:JSON.stringify(output)}}]});
 });
 const res=await handler(request({action:'chat',messages:[{role:'user',content:'今天不太开心。'}],config:{base:'https://attacker.invalid'},key:'client-key',actor:'11111111-1111-4111-8111-111111111111'}));
 assert.equal(res.status,200);const result=await res.json();assert.equal(result.mode,'ai');assert.equal(stage,3);assert.ok(!JSON.stringify(result).includes(secret));
 assert.equal(calls.filter(c=>c.url.startsWith(env.SUPABASE_URL)&&c.body?.includes('今天不太开心')).length,0);
});
test('quota or banned account stops before provider access; upstream details never leak',async()=>{
 for(const failure of ['quota_exceeded','forbidden']){
  const {handler,calls}=mockHandler(c=>c.url.endsWith('/rpc/qh_action')?json({profile:{status:failure==='forbidden'?'banned':'active',admission_status:'approved'}}):json({message:failure,details:'secret-should-not-leak'},400));
  const res=await handler(request({action:'chat',messages:[{role:'user',content:'你好'}]}));
  assert.equal(res.status,failure==='quota_exceeded'?429:403);assert.ok(!(await res.text()).includes('secret-should-not-leak'));
  assert.ok(calls.every(c=>c.url.startsWith(env.SUPABASE_URL)));
 }
});


test('invite codes are generated or normalized, hashed only on server, permission checked before create',async()=>{
 let saved;const {handler}=mockHandler(c=>{
  const p=JSON.parse(c.body);
  if(p.action==='admin.invites.list')return json({items:[]});
  saved=p.payload;assert.equal(p.action,'admin.invites.create');assert.equal(p.aal2,true);return json({ok:true,id:userId});
 });
 const body={action:'admin.invites.create',label:'friends',max_uses:1,code:'Custom-Code-1234',code_hash:'attacker',code_hint:'oops'};
 const denied=await handler(request(body));assert.equal(denied.status,403);assert.equal(saved,undefined);
 const accepted=await handler(request(body,'aal2'));assert.equal(accepted.status,200);
 assert.equal((await accepted.json()).code,'CUSTOM-CODE-1234');assert.equal(saved.code,undefined);assert.match(saved.code_hash,/^[a-f0-9]{64}$/);assert.equal(saved.code_hint,'1234');
 const random=await handler(request({action:'admin.invites.create',label:'random',max_uses:2},'aal2'));
 assert.match((await random.json()).code,/^[A-F0-9]{40}$/);
 for(const bad of [{code:'short'},{max_uses:0},{max_uses:1.5},{expires_at:'2000-01-01'},{label:''}])assert.throws(()=>validateAction({...body,...bad}));
});
test('redemption strips plaintext and forged privileged fields; invalid attempts committed before safe response',async()=>{
 let payload;const {handler}=mockHandler(c=>{
  const p=JSON.parse(c.body);assert.equal(p.action,'admission.redeem');payload=p.payload;
  return json({error_code:'invite_invalid'});
 });
 const res=await handler(request({action:'admission.redeem',code:'CUSTOM-CODE-1234',code_hash:'forged',admission_status:'approved'}));
 assert.equal(res.status,400);assert.equal((await res.json()).code,'invite_invalid');
 assert.deepEqual(Object.keys(payload),['code_hash']);assert.match(payload.code_hash,/^[a-f0-9]{64}$/);
});
test('pending applicant cannot cause quota reservation or provider calls',async()=>{
 const {handler,calls}=mockHandler(c=>{assert.match(c.url,/rpc\/qh_action$/);return json({profile:{status:'active',admission_status:'pending'}});});
 const res=await handler(request({action:'chat',messages:[{role:'user',content:'hello'}]}));
 assert.equal(res.status,403);assert.equal((await res.json()).code,'admission_required');assert.equal(calls.length,2);
});

test('submitted posts and comments run moderation server-side and fail closed, drafts skip provider',async()=>{
 const encrypted_key=await encryptKey('moderation-private',master,config);
 for(const scenario of ['approve','reject','invalid','unconfigured','draft']){
  let completed,providerCalls=0;
  const {handler}=mockHandler(c=>{
   const body=JSON.parse(c.body);
   if(c.url.endsWith('/rpc/qh_action'))return json({ok:true,id:userId,status:scenario==='draft'?'draft':'pending',...(scenario==='draft'?{}:{moderation_job_id:userId})});
   if(c.url.endsWith('/rpc/qh_claim_moderation')){
    assert.equal(body.actor,userId);assert.equal(body.job_id,userId);
    return scenario==='unconfigured'?json({message:'not_configured'},400):json({id:userId,kind:'post',content:{title:'标题',body:'这是测试内容'},context:{},config,encrypted_key,moderation_model:'review-model'});
   }
   if(c.url.endsWith('/rpc/qh_complete_moderation')){completed=body;return json({ok:true,applied:true,status:body.decision==='approve'?'published':body.decision==='reject'?'rejected':'pending'});}
   providerCalls++;assert.equal(JSON.parse(c.body).model,'review-model');assert.equal(c.headers.Authorization,'Bearer moderation-private');
   const output=scenario==='approve'?{decision:'approve',reason:'OK',rule_ids:[],evidence:[]}:scenario==='reject'?{decision:'reject',reason:'bad',rule_ids:[3],evidence:['测试内容']}:{decision:'approve',reason:'bad',rule_ids:[99],evidence:[]};
   return json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]});
  });
  const response=await handler(request({action:'posts.save',title:'标题',body:'这是测试内容',category:'share',preference:'listen',submit:scenario!=='draft',moderation_job_id:'forged'}));
  assert.equal(response.status,200);const result=await response.json();assert.ok(!JSON.stringify(result).includes('moderation-private'));
  assert.equal(result.status,scenario==='approve'?'published':scenario==='reject'?'rejected':scenario==='draft'?'draft':'pending');
  assert.equal(providerCalls,['draft','unconfigured'].includes(scenario)?0:1);
  if(scenario!=='draft')assert.equal(completed.decision,['approve','reject'].includes(scenario)?scenario:'error');
 }
 const {handler,calls}=mockHandler(c=>c.url.endsWith('/rpc/qh_action')?json({ok:true,id:userId,moderation_job_id:userId,status:'pending'}):json({message:'not_configured'},400));
 const response=await handler(request({action:'comments.save',post_id:userId,body:'评论'}));
 assert.equal(response.status,200);assert.equal((await response.json()).status,'pending');assert.ok(calls.some(c=>c.url.endsWith('/rpc/qh_claim_moderation')));
});
