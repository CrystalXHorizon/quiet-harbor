import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createApiHandler} from '../supabase/functions/_shared/api.js';
import {generateEmailCode,emailCodeHash,emailMfaConfigured} from '../supabase/functions/_shared/email-mfa.js';
import {validateAction} from '../supabase/functions/_shared/security.js';

const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',member='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const origin='https://site.example';
const env={SUPABASE_URL:'https://mfa.supabase.co',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'service',ALLOWED_ORIGINS:origin,
 MFA_RESEND_API_KEY:'re_fixture',MFA_EMAIL_FROM:'noreply@auth.example.test',MFA_EMAIL_SECRET:Buffer.alloc(32,7).toString('base64')};
const jwt=(id,sid=first,method='password',aal='aal1')=>'header.'+Buffer.from(JSON.stringify({sub:id,session_id:sid,amr:[{method}],aal})).toString('base64url')+'.signature';

test('email codes are six digits; keyed proofs bind actor, session and challenge; payloads cannot forge authorization',async()=>{
 for(let i=0;i<100;i++)assert.match(generateEmailCode(),/^\d{6}$/);
 const baseline=await emailCodeHash(env,owner,first,second,'123456');
 assert.match(baseline,/^[0-9a-f]{64}$/);
 for(const params of [[member,first,second,'123456'],[owner,second,second,'123456'],[owner,first,first,'123456'],[owner,first,second,'654321']])assert.notEqual(await emailCodeHash(env,...params),baseline);
 assert.deepEqual(validateAction({action:'security.email.verify',challenge_id:first,code:'123456',aal2:true,auth_session:second,native_mfa:true,code_hash:baseline,email:'attacker@example.test'}),{challenge_id:first,code:'123456'});
 for(const code of ['12345','1234567','abcdef'])assert.throws(()=>validateAction({action:'security.email.verify',challenge_id:first,code}));
 assert.deepEqual(validateAction({action:'security.password.update',password:'new-pass',actor:member}),{password:'new-pass'});
 assert.throws(()=>validateAction({action:'security.password.update',password:'short'}));
 assert.equal(emailMfaConfigured({...env,MFA_EMAIL_FROM:'a@example.test\r\nBcc: b@example.test'}),false);
});

test('real SQL and Edge: either factor unlocks management; email proofs expire, cannot replay or cross accounts/sessions, and rate limits persist',async()=>{
 const db=new PGlite();const sent=[];let failSend=false;let configured=true;let passwordUpdates=0;
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');`);
  await db.exec('create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,not_after timestamptz);');
  const directory=new URL('../supabase/migrations/',import.meta.url);
  for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,directory),'utf8'));
  await db.query('insert into auth.users(id,email) values($1,$2),($3,$4)',[owner,'owner@example.test',member,'member@example.test']);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2),($3,$2),($4,$5)',[first,owner,second,'33333333-3333-4333-8333-333333333333',member]);
  await db.exec("update qh_profiles set admission_status='approved';");
  await db.query("update qh_profiles set role='owner' where id=$1",[owner]);
  const handler=()=>createApiHandler({env:configured?env:{...env,MFA_RESEND_API_KEY:undefined},fetchImpl:async(url,options)=>{
   if(url==='https://api.resend.com/emails'){
    const mail=JSON.parse(options.body);assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer re_fixture');
    sent.push({...mail,code:mail.text.match(/\d{6}/)[0]});return Response.json({id:'fixture'}, {status:failSend?503:200});
   }
   if(url.endsWith('/auth/v1/user')){
    const claims=JSON.parse(Buffer.from(options.headers.Authorization.split('.')[1],'base64url'));
    const rows=await db.query('select email from auth.users where id=$1',[claims.sub]);
    return Response.json({id:claims.sub,email:rows.rows[0]?.email,email_confirmed_at:'2026-10-01',factors:[{factor_type:'totp',status:'verified'}]});
   }
   if(url.endsWith('/auth/v1/admin/users/'+owner)){
    assert.equal(options.method,'PUT');assert.deepEqual(JSON.parse(options.body),{password:'new-password-fixture-123'});
    assert.equal((await db.query('select count(*) n from qh_email_mfa_sessions where user_id=$1',[owner])).rows[0].n,0,'password change first revokes application proof');
    passwordUpdates++;return Response.json({id:owner});
   }
   const name=new URL(url).pathname.split('/').pop(),body=JSON.parse(options.body);
   const keys={qh_email_mfa:['actor','auth_session','operation','payload'],qh_action:['actor','action','payload','aal2','auth_session']}[name];
   assert.ok(keys,'only known RPCs may be called');
   try{return Response.json((await db.query(`select public.${name}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) result`,keys.map(key=>body[key]))).rows[0].result);}
   catch(error){return Response.json({message:error.message,code:error.code},{status:400});}
  }});
  const call=async(action,payload={},id=owner,sid=first,method='password',aal='aal1')=>{
   const response=await handler()(new Request(env.SUPABASE_URL+'/functions/v1/api',{method:'POST',headers:{origin,Authorization:'Bearer '+jwt(id,sid,method,aal),'Content-Type':'application/json'},body:JSON.stringify({...payload,action})}));
   return {status:response.status,body:await response.json()};
  };
  const codeCheck=(challenge,code,id=owner,sid=first)=>call('security.email.verify',{challenge_id:challenge,code},id,sid);
  const unlockSend=()=>db.exec("update qh_email_mfa_settings set last_send_at=now()-interval '61 seconds';");
  assert.equal((await call('admin.queue')).body.code,'mfa_required');
  const status=await call('security.mfa.status');assert.equal(status.body.email_available,true);assert.equal(status.body.verified,false);
  const challenge=await call('security.email.send',{email:'attacker@example.test',auth_session:second});assert.equal(challenge.status,200);assert.deepEqual(sent[0].to,['owner@example.test']);
  assert.ok(!JSON.stringify(challenge.body).includes(sent[0].code));assert.ok(!JSON.stringify(challenge.body).includes('code_hash'));
  assert.equal((await call('security.email.send')).status,429);
  assert.equal((await codeCheck(challenge.body.challenge_id,sent[0].code,owner,second)).body.code,'email_code_invalid');
  assert.equal((await codeCheck(challenge.body.challenge_id,sent[0].code,member,'33333333-3333-4333-8333-333333333333')).body.code,'email_code_invalid');
  assert.equal((await codeCheck(challenge.body.challenge_id,sent[0].code)).status,200);
  assert.equal((await call('security.mfa.status')).body.verified,true);
  assert.equal((await call('admin.queue')).status,200,'email proof authorizes actual management SQL');
  await db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1",[first]);
  assert.equal((await call('admin.queue')).body.code,'mfa_required','Auth session timeout invalidates email proof');
  await db.query('update auth.sessions set not_after=null where id=$1',[first]);
  await db.query('delete from auth.sessions where id=$1',[first]);
  assert.equal((await call('security.mfa.status')).body.verified,false,'Auth logout invalidates email proof immediately');
  assert.equal((await call('security.email.send')).body.code,'unauthorized');
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[first,owner]);
  assert.equal((await call('admin.queue',{},owner,second)).body.code,'mfa_required');
  assert.equal((await codeCheck(challenge.body.challenge_id,sent[0].code)).body.code,'email_code_invalid','single use');
  assert.equal((await call('admin.queue',{},owner,second,'password','aal2')).status,200,'TOTP remains an alternative');
  assert.equal((await call('security.email.send',{},owner,first,'otp')).body.code,'password_required','email-only authentication is not a second factor');
  await db.exec("update qh_email_mfa_sessions set verified_until=now()-interval '1 second';");
  assert.equal((await call('admin.queue')).body.code,'mfa_required');
  await unlockSend();const next=await call('security.email.send');
  const wrong=sent.at(-1).code==='000000'?'000001':'000000';
  for(let i=0;i<5;i++)assert.equal((await codeCheck(next.body.challenge_id,wrong)).body.code,'email_code_invalid');
  assert.equal((await db.query('select attempts from qh_email_mfa_challenges where user_id=$1',[owner])).rows[0].attempts,5);
  assert.equal((await codeCheck(next.body.challenge_id,sent.at(-1).code)).body.code,'email_code_invalid','five failures invalidate even a correct code');
  await unlockSend();const expired=await call('security.email.send');
  await db.exec("update qh_email_mfa_challenges set expires_at=now()-interval '1 second';");
  assert.equal((await codeCheck(expired.body.challenge_id,sent.at(-1).code)).body.code,'email_code_invalid');
  await unlockSend();failSend=true;const failure=await call('security.email.send');assert.equal(failure.body.code,'email_send_failed');
  assert.equal((await db.query('select code_hash from qh_email_mfa_challenges where user_id=$1',[owner])).rows[0].code_hash,null);
  failSend=false;await unlockSend();const final=await call('security.email.send');assert.equal(final.status,200);
  assert.equal((await codeCheck(final.body.challenge_id,sent.at(-1).code)).status,200);
  await db.query('update auth.users set email=$1 where id=$2',['changed@example.test',owner]);
  assert.equal((await call('admin.queue')).body.code,'mfa_required','changing email invalidates grants');
  await unlockSend();assert.equal((await call('security.email.send')).status,429,'hourly sending limit survives failures and expired challenges');
  configured=false;assert.equal((await call('security.mfa.status')).body.email_available,false);
  assert.equal((await call('security.email.send')).body.code,'email_mfa_unavailable');configured=true;
  assert.equal((await call('security.email.disable')).body.code,'mfa_required');
  assert.equal((await call('security.email.disable',{},owner,first,'password','aal2')).status,200);
  assert.equal((await db.query('select count(*) n from qh_email_mfa_sessions')).rows[0].n,0);
  assert.equal((await call('security.password.update',{password:'new-password-fixture-123'})).body.code,'mfa_required');
  assert.equal((await call('security.password.update',{password:'new-password-fixture-123'},owner,first,'password','aal2')).status,200);assert.equal(passwordUpdates,1);
  for(const role of ['anon','authenticated']){
   assert.equal((await db.query("select has_function_privilege($1,'qh_email_mfa(uuid,uuid,text,jsonb)','execute') allowed",[role])).rows[0].allowed,false);
   for(const table of ['qh_email_mfa_settings','qh_email_mfa_challenges','qh_email_mfa_sessions'])assert.equal((await db.query(`select has_table_privilege($1,$2,'select') allowed`,[role,table])).rows[0].allowed,false);
  }
  // FK erasure and scheduled cleanup cover MFA state as well as existing content.
  await db.query('delete from auth.users where id=$1',[owner]);
  for(const table of ['qh_email_mfa_settings','qh_email_mfa_challenges','qh_email_mfa_sessions'])assert.equal((await db.query(`select count(*) n from ${table} where user_id=$1`,[owner])).rows[0].n,0);
 }finally{await db.close();}
});
