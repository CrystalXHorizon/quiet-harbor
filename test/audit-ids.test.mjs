import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const owner='11111111-1111-4111-8111-111111111111',mod='22222222-2222-4222-8222-222222222222';
const erased='33333333-3333-4333-8333-333333333333',purged='44444444-4444-4444-8444-444444444444',kept='55555555-5555-4555-8555-555555555555';

test('audit migration retains IDs after Auth deletion and admin purge while erasing private data and enforcing access/retention',async()=>{
 const db=new PGlite();
 const call=async(actor,action,payload={},aal2=true)=>(await db.query('select public.qh_action($1,$2,$3::jsonb,$4) value',[actor,action,JSON.stringify(payload),aal2])).rows[0].value;
 const audit=async(id)=>(await db.query('select * from public.qh_audit where id=$1',[id])).rows[0];
 const record=async(actor,target,action,reason)=>(await db.query('insert into public.qh_audit(actor_id,target_id,action,reason) values($1,$2,$3,$4) returning id',[actor,target,action,reason])).rows[0].id;
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
   create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,not_after timestamptz);`);
  const directory=new URL('../supabase/migrations/',import.meta.url),migration='202610090001_audit_ids_retention.sql';
  for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql')&&f<migration).sort())await db.exec(await readFile(new URL(file,directory),'utf8'));
  for(const [id,role] of [[owner,'owner'],[mod,'moderator'],[erased,'member'],[purged,'member'],[kept,'member']]){
   await db.query('insert into auth.users(id,email) values($1,$2)',[id,`${role}-${id}@example.invalid`]);
   await db.query("update public.qh_profiles set role=$2,admission_status='approved',bio='AUDIT-ERASURE-PRIVATE' where id=$1",[id,role]);
  }
  const session='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[session,erased]);
  const post=(await call(erased,'posts.save',{title:'私有测试正文',body:'AUDIT-ERASURE-PRIVATE',category:'share',preference:'listen',submit:false})).id;
  const byErased=await record(erased,post,'posts.delete','AUDIT-ERASURE-PRIVATE');
  const aboutErased=await record(owner,erased,'user.member.muted','AUDIT-ERASURE-PRIVATE');
  const system=await record(null,post,'moderation.ai.approve','AUDIT-ERASURE-PRIVATE');
  const unaffected=await record(owner,kept,'user.member.active','Unrelated explanation');
  const legacy=await record(null,null,'user.member.active','');
  await db.exec(await readFile(new URL(migration,directory),'utf8'));
  assert.equal((await audit(byErased)).actor_id,erased,'migration does not rewrite retained IDs');

  await db.query('delete from auth.users where id=$1',[erased]);
  for(const id of [byErased,aboutErased,system])assert.equal((await audit(id)).reason,'','private explanations are cleared');
  assert.deepEqual([(await audit(byErased)).actor_id,(await audit(byErased)).target_id],[erased,post]);
  assert.deepEqual([(await audit(aboutErased)).actor_id,(await audit(aboutErased)).target_id],[owner,erased]);
  assert.deepEqual([(await audit(system)).actor_id,(await audit(system)).target_id],[null,post],'system actors stay null');
  assert.equal((await audit(unaffected)).reason,'Unrelated explanation');
  assert.deepEqual([(await audit(legacy)).actor_id,(await audit(legacy)).target_id],[null,null],'previously erased identifiers cannot be recreated');
  for(const [table,column] of [['qh_profiles','id'],['qh_posts','author_id'],['qh_moderation_jobs','author_id'],['qh_usage','user_id'],['auth.sessions','user_id']]){
   assert.equal(Number((await db.query(`select count(*) n from ${table} where ${column}=$1`,[erased])).rows[0].n),0,`${table} is erased`);
  }

  const purgedPost=(await call(purged,'posts.save',{title:'抹除测试',body:'AUDIT-ERASURE-PRIVATE',category:'share',preference:'listen',submit:false})).id;
  const byPurged=await record(purged,purgedPost,'posts.delete','AUDIT-ERASURE-PRIVATE');
  const aboutPurged=await record(owner,purged,'user.member.muted','AUDIT-ERASURE-PRIVATE');
  await assert.rejects(()=>call(owner,'admin.purge',{id:purged,reason:'confirmed'},false),/mfa_required/);
  await assert.rejects(()=>call(mod,'admin.purge',{id:purged,reason:'confirmed'}),/forbidden/);
  await assert.rejects(()=>call(owner,'admin.purge',{id:owner,reason:'confirmed'}),/forbidden/);
  await assert.rejects(()=>call(owner,'admin.purge',{id:purged,reason:''}),/validation/);
  assert.equal(Number((await db.query("select count(*) n from qh_audit where action='admin.purge'")).rows[0].n),0,'denied purges leave no audit');
  await call(owner,'admin.purge',{id:purged,reason:'AUDIT-ERASURE-PRIVATE'});
  assert.equal(Number((await db.query('select count(*) n from auth.users where id=$1',[purged])).rows[0].n),0);
  assert.equal((await audit(byPurged)).actor_id,purged);assert.equal((await audit(byPurged)).target_id,purgedPost);assert.equal((await audit(byPurged)).reason,'');
  assert.equal((await audit(aboutPurged)).target_id,purged);assert.equal((await audit(aboutPurged)).reason,'');
  const purge=(await db.query("select * from qh_audit where action='admin.purge'")).rows[0];
  assert.equal(purge.actor_id,owner);assert.equal(purge.target_id,purged);assert.ok(!purge.reason.includes('AUDIT-ERASURE-PRIVATE'));
  const events=(await call(owner,'admin.audit')).events;
  assert.equal(events.find(e=>e.id===purge.id).target_id,purged,'owner RPC returns the erased target ID');
  assert.equal(events.find(e=>e.id===byErased).actor_id,erased,'owner RPC returns the erased actor ID');
  await assert.rejects(()=>call(owner,'admin.audit',{},false),/mfa_required/);
  await assert.rejects(()=>call(mod,'admin.audit'),/forbidden/);
  await assert.rejects(()=>call(kept,'admin.audit'),/forbidden/);
  for(const role of ['anon','authenticated','service_role']){
   for(const fn of ['qh_action_before_audit_ids(uuid,text,jsonb,boolean,uuid)','qh_erase_account_attribution()']){
    assert.equal((await db.query("select has_function_privilege($1,$2,'execute') allowed",[role,fn])).rows[0].allowed,false,`${role} cannot call ${fn}`);
   }
  }
  assert.equal((await db.query('select public.qh_backend_version() value')).rows[0].value.schema,'202610090001');
  await db.query("update qh_audit set created_at=now()-interval '181 days' where id=$1",[byErased]);
  await db.exec("update qh_maintenance set last_run='-infinity';select public.qh_cleanup();");
  assert.equal(await audit(byErased),undefined,'retained identifiers still expire at 180 days');
  assert.equal((await audit(aboutErased)).target_id,erased,'recent records remain');
 }finally{await db.close();}
});
