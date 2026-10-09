import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const owner='11111111-1111-4111-8111-111111111111',member='22222222-2222-4222-8222-222222222222',mod='33333333-3333-4333-8333-333333333333';
test('owner audit resolves nicknames and typed object labels without disclosing private data or restoring erased names',async()=>{
 const db=new PGlite();
 const call=async(actor,action,payload={},aal2=true)=>(await db.query('select public.qh_action($1,$2,$3::jsonb,$4) value',[actor,action,JSON.stringify(payload),aal2])).rows[0].value;
 const record=async(action,target,actor=owner)=>(await db.query('insert into qh_audit(actor_id,action,target_id) values($1,$2,$3) returning id',[actor,action,target])).rows[0].id;
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
   create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,not_after timestamptz);`);
  const directory=new URL('../supabase/migrations/',import.meta.url);
  for(const f of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(f,directory),'utf8'));
  for(const [id,role,nickname] of [[owner,'owner','测试站长'],[member,'member','小岸'],[mod,'moderator','测试管理员']]){
   await db.query('insert into auth.users(id,email) values($1,$2)',[id,`${role}@private.example.invalid`]);
   await db.query("update qh_profiles set role=$2,nickname=$3,admission_status='approved',bio='PRIVATE-BIO' where id=$1",[id,role,nickname]);
  }
  const post=(await db.query("insert into qh_posts(author_id,title,body,category,preference,status) values($1,'可以慢慢说','PRIVATE-BODY','share','listen','published') returning id",[member])).rows[0].id;
  const comment=(await db.query("insert into qh_comments(author_id,post_id,body) values($1,$2,'PRIVATE-COMMENT') returning id",[member,post])).rows[0].id;
  const report=(await db.query("insert into qh_reports(author_id,post_id,reason) values($1,$2,'PRIVATE-REPORT') returning id",[member,post])).rows[0].id;
  const appeal=(await db.query("insert into qh_appeals(author_id,post_id,reason) values($1,$2,'PRIVATE-APPEAL') returning id",[member,post])).rows[0].id;
  const invite=(await db.query("insert into qh_invites(code_hash,code_hint,label,max_uses,created_by) values($1,'TEST','入站邀请',1,$2) returning id",['f'.repeat(64),owner])).rows[0].id;
  const ids={user:await record('user.member.active',member),post:await record('moderation.ai.approve',post,null),comment:await record('moderate.comment.approve',comment),report:await record('moderate.report.resolve',report),appeal:await record('moderate.appeal.resolve',appeal),invite:await record('invite.create',invite),deleted:await record('posts.delete','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',member)};
  const page=await call(owner,'admin.audit'),get=kind=>page.events.find(e=>e.id===ids[kind]);
  assert.equal(page.hasMore,false);assert.deepEqual(page.events.map(e=>e.id),Object.values(ids).reverse());
  assert.equal(get('user').actor_nickname,'测试站长');assert.equal(get('user').target_nickname,'小岸');assert.equal(get('user').target_id,member);
  for(const kind of ['post','comment','report','appeal']){
   assert.equal(get(kind).target_kind,kind);assert.equal(get(kind).target_nickname,'小岸');assert.equal(get(kind).target_label,'可以慢慢说');assert.equal(get(kind).target_exists,true);
  }
  assert.equal(get('post').actor_id,null);assert.equal(get('post').actor_nickname,null);
  assert.equal(get('invite').target_label,'入站邀请');assert.equal(get('invite').target_nickname,'测试站长');
  const redeemed=await record('admission.invite',invite,member);
  const redeemedEvent=(await call(owner,'admin.audit')).events.find(e=>e.id===redeemed);
  assert.equal(redeemedEvent.target_kind,'invite');assert.equal(redeemedEvent.target_label,'入站邀请');
  assert.equal(get('deleted').target_kind,'post');assert.equal(get('deleted').target_exists,false);assert.equal(get('deleted').actor_nickname,'小岸');
  const serialized=JSON.stringify(page);
  for(const privateValue of ['PRIVATE-BIO','PRIVATE-BODY','PRIVATE-COMMENT','PRIVATE-REPORT','PRIVATE-APPEAL','private.example.invalid','f'.repeat(64)])assert.ok(!serialized.includes(privateValue),privateValue+' is not returned');
  await db.query('update qh_profiles set nickname=$1 where id=$2',['新昵称',member]);
  assert.equal((await call(owner,'admin.audit')).events.find(e=>e.id===ids.user).target_nickname,'新昵称','names reflect current profile');
  await assert.rejects(()=>call(owner,'admin.audit',{},false),/mfa_required/);
  await assert.rejects(()=>call(member,'admin.audit'),/forbidden/);
  await assert.rejects(()=>call(mod,'admin.audit'),/forbidden/);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,'public.qh_action_before_audit_names(uuid,text,jsonb,boolean,uuid)','execute') allowed",[role])).rows[0].allowed,false);
  await call(owner,'admin.purge',{id:member,reason:'synthetic confirmed erasure'});
  const after=await call(owner,'admin.audit');
  const erased=after.events.find(e=>e.id===ids.user),deletedActor=after.events.find(e=>e.id===ids.deleted);
  assert.equal(erased.target_id,member);assert.equal(erased.target_nickname,null);assert.equal(erased.target_exists,false);
  assert.equal(deletedActor.actor_id,member);assert.equal(deletedActor.actor_nickname,null);
  assert.ok(!JSON.stringify(after).includes('新昵称'),'erasure does not retain nickname copies');
  for(let i=0;i<25;i++)await record('user.member.active',mod);
  const first=await call(owner,'admin.audit',{page:0}),second=await call(owner,'admin.audit',{page:1});
  assert.equal(first.events.length,20);assert.equal(first.hasMore,true);assert.ok(!first.events.some(e=>second.events.some(v=>v.id===e.id)));
  assert.equal(first.events[0].target_nickname,'测试管理员');
 }finally{await db.close();}
});
