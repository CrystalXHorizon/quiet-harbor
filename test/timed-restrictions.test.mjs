import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {validateAction} from '../supabase/functions/_shared/security.js';

const owner='11111111-1111-4111-8111-111111111111',mod='22222222-2222-4222-8222-222222222222',member='33333333-3333-4333-8333-333333333333',pending='44444444-4444-4444-8444-444444444444';
test('restriction input rejects malformed, conflicting, expired and unrelated timers',()=>{
 const base={action:'admin.user',id:member,status:'banned',reason:'测试'};
 for(const bad of [{duration_seconds:0},{duration_seconds:1.5},{duration_seconds:'86400'},{duration_seconds:31536001},{duration_seconds:null},{status_until:''},{status_until:123},{status_until:'infinity'},{status_until:'2020-01-01T00:00:00Z'},{status_until:new Date(Date.now()+31600000000).toISOString()},{duration_seconds:60,status_until:null},{status:'active',duration_seconds:60},{status:'active',status_until:null}])assert.throws(()=>validateAction({...base,...bad}));
 assert.deepEqual(validateAction({action:'profile.update',nickname:'测试',duration_seconds:60}),{nickname:'测试'});
 assert.deepEqual(validateAction({...base,status_until:null,status_started_at:'spoofed'}),{id:member,status:'banned',reason:'测试',status_until:null});
 assert.equal(validateAction({...base,duration_seconds:86400}).duration_seconds,86400);
 assert.ok(validateAction({...base,status_until:new Date(Date.now()+86400000).toISOString()}).status_until);
});

test('real SQL restrictions expire across account, community, AI, MFA and maintenance without bypassing permissions',async()=>{
 const db=new PGlite();
 const call=async(actor,action,payload={},aal2=true)=>(await db.query('select public.qh_action($1,$2,$3::jsonb,$4) value',[actor,action,JSON.stringify(payload),aal2])).rows[0].value;
 const adjustment=async(status,timing={},actor=owner)=>call(actor,'admin.user',{id:member,status,reason:'测试账号限制',...timing});
 const profile=async(id=member)=>(await db.query('select * from qh_profiles where id=$1',[id])).rows[0];
 const expire=()=>db.query("update qh_profiles set status_until=now()-interval '1 second' where id=$1",[member]);
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
   create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,not_after timestamptz);`);
  const directory=new URL('../supabase/migrations/',import.meta.url);
  const files=(await readdir(directory)).filter(f=>f.endsWith('.sql')).sort();
  for(const f of files.filter(f=>!f.startsWith('202610040002')))await db.exec(await readFile(new URL(f,directory),'utf8'));
  for(const [id,role] of [[owner,'owner'],[mod,'moderator'],[member,'member'],[pending,'member']]){
   await db.query('insert into auth.users(id,email) values($1,$2)',[id,`${role}-${id}@example.invalid`]);
   await db.query("update qh_profiles set role=$2,admission_status=$3 where id=$1",[id,role,id===pending?'pending':'approved']);
  }
  await db.query("update qh_profiles set status='banned' where id=$1",[member]);
  await db.exec(await readFile(new URL('202610040002_timed_restrictions.sql',directory),'utf8'));
  assert.equal((await profile()).status_until,null,'legacy bans remain permanent');
  assert.equal((await call(member,'me')).profile.status,'banned');
  await adjustment('active');

  await assert.rejects(()=>adjustment('muted'),/validation/,'new restrictions require explicit timing');
  assert.equal((await profile()).status,'active');
  const before=(await db.query('select count(*) n from qh_audit')).rows[0].n;
  for(const timing of [{duration_seconds:0},{duration_seconds:1.5},{duration_seconds:31536001},{duration_seconds:60,status_until:null},{status_until:'infinity'},{status_until:'2020-01-01T00:00:00Z'},{status_until:new Date(Date.now()+31600000000).toISOString()}])await assert.rejects(()=>adjustment('banned',timing),/validation/);
  assert.equal((await profile()).status,'active');
  assert.equal((await db.query('select count(*) n from qh_audit')).rows[0].n,before,'failed adjustments roll audit and profile back');
  await assert.rejects(()=>adjustment('banned',{duration_seconds:86400},mod),/forbidden/);
  await assert.rejects(()=>adjustment('muted',{duration_seconds:86400},member),/forbidden/);
  await assert.rejects(()=>call(owner,'admin.user',{id:member,status:'muted',duration_seconds:86400,reason:'test'},false),/mfa_required/);
  await assert.rejects(()=>call(owner,'admin.user',{id:owner,status:'banned',duration_seconds:86400,reason:'test'}),/forbidden/);
  assert.equal((await profile()).status,'active');

  let r=await adjustment('muted',{duration_seconds:86400},mod);
  assert.ok(Math.abs(Date.parse(r.profile.status_until)-Date.now()-86400000)<5000);
  assert.ok(r.profile.status_started_at);assert.equal(r.profile.bio,undefined);
  await assert.rejects(()=>call(member,'posts.save',{title:'test',body:'test',category:'share',preference:'listen',submit:false}),/muted/);
  await assert.rejects(()=>call(member,'comments.save',{post_id:owner,body:'test'}),/muted/);
  const until=(await profile()).status_until;
  await call(owner,'admin.user',{id:member,role:'moderator',status:'muted',reason:'角色调整'});
  assert.equal(Date.parse((await profile()).status_until),Date.parse(until),'role edits keep the existing deadline');
  await expire();
  const draft=await call(member,'posts.save',{title:'恢复后',body:'已经到期',category:'share',preference:'listen',submit:false});assert.ok(draft.id);
  assert.equal((await profile()).status,'active');assert.equal((await profile()).status_until,null);
  const expiryCount=async()=>Number((await db.query("select count(*) n from qh_audit where action='user.restriction.expired'")).rows[0].n);
  assert.equal(await expiryCount(),1);await call(member,'me');await db.exec('select qh_cleanup()');assert.equal(await expiryCount(),1,'expiration is audited once');
  assert.ok((await db.query("select status_until from qh_audit where action='user.restriction.expired'")).rows[0].status_until);

  const custom=new Date(Date.now()+3600000).toISOString();
  r=await adjustment('banned',{status_until:custom});assert.equal(Date.parse(r.profile.status_until),Date.parse(custom));
  await assert.rejects(()=>call(member,'posts.list'),/forbidden/);
  assert.equal((await call(member,'me')).profile.status,'banned');
  await assert.rejects(()=>db.query('select qh_reserve_model($1,$2)',[member,'chat']),/forbidden/);
  await assert.rejects(()=>adjustment('active',{},mod),/forbidden/,'moderators cannot undo owner bans');
  await expire();assert.equal((await call(member,'me')).profile.status,'active');

  // Direct model reservation and email verification also recheck expiration.
  await db.exec(`update qh_ai_settings set enabled=true,config='{"model":"test"}',encrypted_key='{}';`);
  await adjustment('banned',{duration_seconds:3600});await expire();await db.query('select qh_reserve_ai($1)',[member]);assert.equal((await profile()).status,'active');
  const session='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[session,member]);
  await adjustment('banned',{duration_seconds:3600});await expire();
  await db.query("select qh_email_mfa($1,$2,'start',$3)",[member,session,{email:(await db.query('select email from auth.users where id=$1',[member])).rows[0].email,challenge_id:owner,code_hash:'a'.repeat(64)}]);
  assert.equal((await profile()).status,'active');

  await adjustment('banned',{status_until:null});await db.exec('select qh_cleanup()');assert.equal((await profile()).status,'banned');assert.equal((await profile()).status_until,null);
  await adjustment('active');assert.equal((await profile()).status_started_at,null);
  await adjustment('muted',{duration_seconds:3600});await expire();await db.exec('select qh_cleanup()');assert.equal((await profile()).status,'active','maintenance restores inactive users too');
  await db.query("update qh_profiles set status='banned',status_until=now()-interval '1 second' where id=$1",[pending]);
  // A separate update supplies the fixture deadline after the status trigger.
  await db.query("update qh_profiles set status_until=now()-interval '1 second' where id=$1",[pending]);
  assert.equal((await call(pending,'me')).profile.admission_status,'pending');
  await assert.rejects(()=>call(pending,'posts.list'),/admission_required/,'expiration never grants admission');
  for(const role of ['anon','authenticated','service_role'])for(const fn of ['qh_expire_restrictions(uuid)','qh_action_before_timed_restrictions(uuid,text,jsonb,boolean,uuid)','qh_reserve_model_before_timed_restrictions(uuid,text)','qh_email_mfa_before_timed_restrictions(uuid,uuid,text,jsonb)'])assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') allowed',[role,fn])).rows[0].allowed,false,`${role} cannot call ${fn}`);
 }finally{await db.close();}
});
