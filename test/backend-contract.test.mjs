import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createApiHandler,moderationConnection} from '../supabase/functions/_shared/api.js';
import {encryptKey} from '../supabase/functions/_shared/security.js';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config={provider:'deepseek',base:'https://api.deepseek.com',protocol:'openai',model:'chat-model',tokenField:'max_tokens',jsonMode:true};
test('real SQL RPC output feeds the Edge gateway: me, settings, reservations, claim and completion',async()=>{
 const db=new PGlite();const master=Buffer.alloc(32,9).toString('base64');
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');`);
  const directory=new URL('../supabase/migrations/',import.meta.url);
  for(const f of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(f,directory),'utf8'));
  await db.query('insert into auth.users(id,email) values($1,$2)',[id,'contract@example.test']);
  await db.query("update qh_profiles set role='owner',admission_status='approved' where id=$1",[id]);
  const ciphertext=await encryptKey('contract-secret-key',master,config);
  await db.query("update qh_ai_settings set config=$1,encrypted_key=$2,enabled=true,moderation_model='review-model'",[config,ciphertext]);
  const rpc=async(name,p)=>{
   const keys={qh_action:['actor','action','payload','aal2'],qh_reserve_ai:['actor'],qh_reserve_model:['actor','kind'],qh_record_ai_call:['actor','kind','start_turn'],qh_claim_moderation:['actor','job_id'],qh_complete_moderation:['actor','job_id','decision','reason','rule_ids','policy_version','model'],qh_backend_version:[]}[name];
   assert.ok(keys,'unexpected RPC '+name);
   return (await db.query(`select public.${name}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) value`,keys.map(k=>p[k]))).rows[0].value;
  };
  let upstream=0;
  const handler=createApiHandler({env:{SUPABASE_URL:'https://contract.supabase.co',SUPABASE_ANON_KEY:'anon-fixture',SUPABASE_SERVICE_ROLE_KEY:'service-fixture',AI_ENCRYPTION_KEY:master,ALLOWED_ORIGINS:'https://site.example'},fetchImpl:async(url,o)=>{
   const path=new URL(url).pathname;
   if(path==='/auth/v1/user')return Response.json({id,email_confirmed_at:'2026-10-03',factors:[]});
   if(path.startsWith('/rest/v1/rpc/'))return Response.json(await rpc(path.split('/').at(-1),JSON.parse(o.body)));
   if(path==='/rest/v1/qh_ai_settings')return Response.json((await db.query('select config,encrypted_key,enabled from qh_ai_settings where id=true')).rows);
   assert.equal(String(url),'https://api.deepseek.com/chat/completions');upstream++;
   assert.equal(JSON.parse(o.body).model,'review-model');
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({decision:'approve',reason:'内容合规',rule_ids:[],evidence:[]})}}]});
  }});
  const token='header.'+Buffer.from(JSON.stringify({sub:id,aal:'aal2'})).toString('base64url')+'.signature';
  const request=body=>new Request('https://contract.supabase.co/functions/v1/api',{method:'POST',headers:{Origin:'https://site.example',Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const me=await handler(request({action:'me'}));assert.equal(me.status,200);assert.equal((await me.json()).profile.id,id);
  const result=await handler(request({action:'posts.save',title:'真实 SQL 契约',body:'供契约检查的内容。',category:'share',preference:'listen',submit:true}));
  assert.equal(result.status,200);const saved=await result.json();assert.equal(saved.status,'published');assert.equal(upstream,1);
  const usage=(await db.query('select * from qh_usage where user_id=$1',[id])).rows[0];assert.equal(usage.used,1);assert.equal(usage.provider_calls,1);assert.equal(usage.moderation_used,1);
  const job=(await db.query('select * from qh_moderation_jobs where id=$1',[saved.moderation_job_id])).rows[0];assert.equal(job.model,'review-model');assert.equal(job.status,'approve');
  // An actual SQL rename must break the consumer, not silently fall back to chat-model.
  await db.exec(`do $$ declare src text;begin src:=pg_get_functiondef('public.qh_claim_moderation(uuid,uuid)'::regprocedure);execute replace(src,'''config'',case','''renamed_config'',case');end $$;`);
  const pending=await rpc('qh_action',{actor:id,action:'posts.save',payload:{title:'Renamed','body':'contract text','category':'share',preference:'listen',submit:true},aal2:true});
  const changed=await rpc('qh_claim_moderation',{actor:id,job_id:pending.moderation_job_id});
  assert.ok(changed.renamed_config);assert.equal(changed.config,undefined);assert.throws(()=>moderationConnection(changed,''));
  const settings=await handler(request({action:'admin.ai.get'}));assert.equal(settings.status,200);assert.equal((await settings.json()).key_set,true);
  const reserved=await rpc('qh_reserve_ai',{actor:id});assert.deepEqual(reserved.config,config);assert.deepEqual(reserved.encrypted_key,ciphertext);
  const health=await handler(new Request('https://contract.supabase.co/functions/v1/api/health',{headers:{Origin:'https://site.example'}}));assert.equal(health.status,200);assert.equal((await health.json()).schema,'202610030004');
 }finally{await db.close();}
});
