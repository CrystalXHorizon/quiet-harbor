import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const ids=Array.from({length:10},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
test('admission migration preserves members, gates pending accounts, reviews and redeems without permission bypass',async()=>{
 const db=new PGlite();
 const [owner,mod,applicant,other,rejected,banned,expired,disabled,guesser]=ids;
 const hash='a'.repeat(64);
 const call=async(actor,action,payload={},aal2=false)=>(await db.query('select public.qh_action($1,$2,$3::jsonb,$4) result',[actor,action,JSON.stringify(payload),aal2])).rows[0].result;
 const create=async(id,metadata={})=>db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2::jsonb)',[id,JSON.stringify(metadata)]);
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');`);
  const directory=new URL('../supabase/migrations/',import.meta.url);
  const migrations=(await readdir(directory)).filter(f=>f.endsWith('.sql')).sort();
  await db.exec(await readFile(new URL(migrations.shift(),directory),'utf8'));
  await create(owner);await create(mod);
  await db.query("update qh_profiles set role=case when id=$1 then 'owner' else 'moderator' end",[owner]);
  for(const file of migrations)await db.exec(await readFile(new URL(file,directory),'utf8'));
  assert.equal((await call(owner,'me')).profile.admission_status,'approved');
  for(const id of ids.slice(2))await create(id,{role:'owner',admission_status:'approved'});
  const me=await call(applicant,'me');assert.equal(me.profile.admission_status,'pending');assert.equal(me.profile.role,'member');assert.equal(me.ai.ready,false);
  for(const action of ['posts.list','posts.get','posts.save','profile.update','admin.users','admin.invites.list','blocks.list'])await assert.rejects(()=>call(applicant,action),/admission_required/);
  await assert.rejects(()=>db.query('select qh_reserve_ai($1)',[applicant]),/admission_required/);
  for(const role of ['anon','authenticated']){
   const permissions=(await db.query(`select has_table_privilege($1,'qh_applications','select') a,has_table_privilege($1,'qh_invites','select') b,has_function_privilege($1,'qh_action(uuid,text,jsonb,boolean)','execute') c`,[role])).rows[0];
   assert.deepEqual(permissions,{a:false,b:false,c:false});
  }
  assert.equal((await db.query("select has_function_privilege('service_role','qh_action_admitted(uuid,text,jsonb,boolean)','execute') allowed")).rows[0].allowed,false);
  assert.equal((await db.query("select has_function_privilege('service_role','qh_reserve_ai_admitted(uuid)','execute') allowed")).rows[0].allowed,false);
  await call(applicant,'admission.apply',{reason:'想加入互助社区'});
  assert.equal((await call(applicant,'me')).application.status,'pending');
  assert.equal((await call(mod,'admin.applications',{},true)).items[0].id,applicant);
  await assert.rejects(()=>call(mod,'admin.application.review',{id:applicant,status:'approved',reason:'欢迎'}),/mfa_required/);
  await call(mod,'admin.application.review',{id:applicant,status:'approved',reason:'欢迎'},true);
  assert.equal((await call(applicant,'me')).profile.admission_status,'approved');
  assert.deepEqual((await call(applicant,'posts.list')).posts,[]);
  await assert.rejects(()=>call(applicant,'admin.invites.list'),/forbidden/);
  for(const action of ['admin.invites.list','admin.invites.create','admin.invites.update'])await assert.rejects(()=>call(mod,action,{},true),/forbidden/);
  await assert.rejects(()=>call(owner,'admin.invites.create',{code_hash:hash,code_hint:'AAAA',label:'test',max_uses:1}),/mfa_required/);
  const invitation=await call(owner,'admin.invites.create',{code_hash:hash,code_hint:'AAAA',label:'test',max_uses:1},true);
  const list=await call(owner,'admin.invites.list',{},true);assert.equal(list.items[0].code_hash,undefined);
  assert.equal((await call(other,'admission.redeem',{code_hash:hash})).status,'approved');
  // A retry from the same user is idempotent, and a different user cannot exceed the last available use.
  await call(other,'admission.redeem',{code_hash:hash});
  assert.equal((await call(rejected,'admission.redeem',{code_hash:hash})).error_code,'invite_invalid');
  assert.equal((await call(owner,'admin.invites.list',{},true)).items[0].used,1);
  await call(rejected,'admission.apply',{reason:'申请'});
  await call(owner,'admin.application.review',{id:rejected,status:'rejected',reason:'请补充说明'},true);
  assert.equal((await call(rejected,'me')).application.review_reason,'请补充说明');
  await assert.rejects(()=>call(owner,'admin.user',{id:rejected,role:'moderator',reason:'test'},true),/admission_required/);
  const fresh='b'.repeat(64);
  await call(owner,'admin.invites.create',{code_hash:fresh,code_hint:'BBBB',label:'fresh',max_uses:2},true);
  assert.equal((await call(rejected,'admission.redeem',{code_hash:fresh})).status,'approved');
  await db.query("update qh_profiles set status='banned' where id=$1",[banned]);
  await assert.rejects(()=>call(banned,'admission.redeem',{code_hash:fresh}),/forbidden/);
  const e='c'.repeat(64);const d='d'.repeat(64);
  const ex=await call(owner,'admin.invites.create',{code_hash:e,code_hint:'CCCC',label:'expired',max_uses:1},true);
  await db.query("update qh_invites set expires_at=now()-interval '1 minute' where id=$1",[ex.id]);
  assert.equal((await call(expired,'admission.redeem',{code_hash:e})).error_code,'invite_invalid');
  const dis=await call(owner,'admin.invites.create',{code_hash:d,code_hint:'DDDD',label:'disabled',max_uses:1},true);
  await call(owner,'admin.invites.update',{id:dis.id,enabled:false},true);
  assert.equal((await call(disabled,'admission.redeem',{code_hash:d})).error_code,'invite_invalid');
  for(let i=0;i<10;i++)assert.equal((await call(guesser,'admission.redeem',{code_hash:'e'.repeat(64)})).error_code,'invite_invalid');
  await assert.rejects(()=>call(guesser,'admission.redeem',{code_hash:fresh}),/rate_limit/);
  assert.equal((await db.query("select used from qh_rate_limits where user_id=$1 and bucket='admission'",[guesser])).rows[0].used,10);
  assert.ok((await db.query("select count(*)::integer n from qh_audit where action like 'admission.%' or action like 'invite.%'")).rows[0].n>=9);
  for(let n=0;n<21;n++)await call(owner,'admin.invites.create',{code_hash:n.toString(16).padStart(64,'0'),code_hint:'TEST',label:'page',max_uses:1},true);
  const first=await call(owner,'admin.invites.list',{page:0},true);
  const second=await call(owner,'admin.invites.list',{page:1},true);
  assert.equal(first.items.length,20);assert.equal(first.hasMore,true);
  assert.equal(second.items.length,5);assert.equal(second.hasMore,false);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,25);
 }finally{await db.close();}
});
