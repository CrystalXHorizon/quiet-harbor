-- Automatically executed by test/backend-db.test.mjs using real PostgreSQL (PGlite).
-- All fixtures and changes are rolled back. Test identities must not be real users.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('11111111-1111-4111-8111-111111111111','qh-test-owner@example.invalid','{"nickname":"owner","role":"owner"}'),
 ('22222222-2222-4222-8222-222222222222','qh-test-member@example.invalid','{"nickname":"member","role":"owner"}'),
 ('33333333-3333-4333-8333-333333333333','qh-test-mod@example.invalid','{"nickname":"moderator"}'),
 ('44444444-4444-4444-8444-444444444444','qh-test-other@example.invalid','{"nickname":"other"}');

do $$ declare a constant uuid:='11111111-1111-4111-8111-111111111111'; b constant uuid:='22222222-2222-4222-8222-222222222222'; m constant uuid:='33333333-3333-4333-8333-333333333333'; o constant uuid:='44444444-4444-4444-8444-444444444444';
 p uuid; draft_id uuid; comment_id uuid; r jsonb; failed boolean;
begin
 if (select role from public.qh_profiles where id=b)<>'member' then raise exception 'untrusted signup role used'; end if;
 -- These fixtures represent previously admitted members.
 update public.qh_profiles set admission_status='approved';
 -- No existing owner is allowed in a disposable test database.
 update public.qh_profiles set role='owner' where id=a;
 update public.qh_profiles set role='moderator' where id=m;
 -- Empty dashboards still execute every query branch and must return valid data.
 r:=public.qh_action(a,'admin.queue','{}',true);
 if r <> '{"posts":[],"comments":[],"reports":[],"appeals":[]}'::jsonb then raise exception 'unexpected empty queue'; end if;
 r:=public.qh_action(a,'admin.usage','{}',true);
 if (r->>'total')::integer<>0 or r->'users'<>'[]'::jsonb then raise exception 'unexpected empty usage'; end if;
 if has_table_privilege('authenticated','public.qh_ai_settings','select') then raise exception 'ciphertext table readable by browser'; end if;
 if has_table_privilege('anon','public.qh_posts','select') then raise exception 'anonymous table access'; end if;
 if has_function_privilege('authenticated','public.qh_action(uuid,text,jsonb,boolean)','execute') then raise exception 'actor RPC callable by browser'; end if;
 if has_function_privilege('anon','public.qh_reserve_ai(uuid)','execute') then raise exception 'quota RPC callable by browser'; end if;
 if exists(select 1 from pg_tables where schemaname='public' and tablename like 'qh_%' and not rowsecurity) then raise exception 'missing RLS'; end if;

 failed:=false;begin perform public.qh_action(b,'admin.ai.get');exception when others then failed:=sqlerrm='forbidden';end;
 if not failed then raise exception 'member got admin config'; end if;
 failed:=false;begin perform public.qh_action(a,'admin.ai.save','{}',false);exception when others then failed:=sqlerrm='mfa_required';end;
 if not failed then raise exception 'AI save bypassed MFA'; end if;
 failed:=false;begin perform public.qh_action(a,'admin.user',jsonb_build_object('id',b,'role','moderator','reason','test'),false);exception when others then failed:=sqlerrm='mfa_required';end;
 if not failed then raise exception 'role edit bypassed MFA'; end if;
 failed:=false;begin perform public.qh_action(m,'admin.user',jsonb_build_object('id',b,'status','banned','reason','test'),true);exception when others then failed:=sqlerrm='forbidden';end;
 if not failed then raise exception 'moderator banned user'; end if;
 failed:=false;begin perform public.qh_action(a,'admin.user',jsonb_build_object('id',a,'role','member','reason','test'),true);exception when others then failed:=sqlerrm='forbidden';end;
 if not failed then raise exception 'owner demoted self'; end if;

 r:=public.qh_action(b,'posts.save','{"title":"Original","body":"Approved body","category":"share","preference":"listen","submit":true}');p:=(r->>'id')::uuid;
 r:=public.qh_action(o,'posts.list');if jsonb_array_length(r->'posts')<>0 then raise exception 'pending post leaked';end if;
 perform public.qh_action(m,'admin.moderate',jsonb_build_object('kind','post','id',p,'decision','approve','reason','ok'),true);
 perform public.qh_action(b,'posts.save',jsonb_build_object('id',p,'title','Revision','body','UNREVIEWED','category','advice','preference','advice','submit',true));
 r:=public.qh_action(o,'posts.get',jsonb_build_object('id',p));if r->'post'->>'body'<>'Approved body' then raise exception 'unapproved revision leaked';end if;
 r:=public.qh_action(b,'posts.get',jsonb_build_object('id',p));if r->'post'->>'body'<>'UNREVIEWED' or r->'post'->>'status'<>'pending' then raise exception 'author cannot see revision';end if;
 perform public.qh_action(m,'admin.moderate',jsonb_build_object('kind','post','id',p,'decision','reject','reason','revise'),true);
 r:=public.qh_action(o,'posts.get',jsonb_build_object('id',p));if r->'post'->>'body'<>'Approved body' then raise exception 'rejected revision replaced published';end if;
 perform public.qh_action(b,'appeals.create',jsonb_build_object('post_id',p,'reason','please review'));
 perform public.qh_action(b,'posts.save',jsonb_build_object('id',p,'title','Draft edit','body','PRIVATE DRAFT EDIT','category','share','preference','listen','submit',false));
 r:=public.qh_action(m,'posts.get',jsonb_build_object('id',p));if r->'post'->>'body'<>'Approved body' then raise exception 'staff saw unsubmitted revision';end if;
 r:=public.qh_action(b,'posts.save','{"title":"Draft","body":"PRIVATE DRAFT","category":"share","preference":"listen","submit":false}');draft_id:=(r->>'id')::uuid;
 failed:=false;begin perform public.qh_action(m,'posts.get',jsonb_build_object('id',draft_id));exception when others then failed:=sqlerrm='not_found';end;
 if not failed then raise exception 'staff saw unsubmitted draft'; end if;
 failed:=false;begin perform public.qh_action(m,'admin.moderate',jsonb_build_object('kind','post','id',draft_id,'decision','hide','reason','test'),true);exception when others then failed:=sqlerrm='not_found';end;
 if not failed then raise exception 'staff hid unsubmitted draft to expose it'; end if;
 failed:=false;begin perform public.qh_action(o,'posts.delete',jsonb_build_object('id',p));exception when others then failed:=sqlerrm='not_found';end;
 if not failed then raise exception 'nonowner deleted post'; end if;

 r:=public.qh_action(o,'comments.save',jsonb_build_object('post_id',p,'body','Unreviewed comment'));comment_id:=(r->>'id')::uuid;
 perform public.qh_action(o,'reports.create',jsonb_build_object('post_id',p,'reason','review post'));
 r:=public.qh_action(m,'admin.queue','{}',true);
 if jsonb_array_length(r->'comments')<>1 or jsonb_array_length(r->'reports')<>1 or jsonb_array_length(r->'appeals')<>1 then raise exception 'populated moderation queue incomplete'; end if;
 if r->'reports'->0->>'target_body'<>'Approved body' or r->'appeals'->0->>'target_title'<>'Revision' or r->'appeals'->0->>'target_body'<>'UNREVIEWED' then raise exception 'queue joined wrong record'; end if;
 if r::text like '%PRIVATE DRAFT%' then raise exception 'queue exposes draft'; end if;
 r:=public.qh_action(b,'posts.get',jsonb_build_object('id',p));if jsonb_array_length(r->'comments')<>0 then raise exception 'pending comment leaked';end if;
 perform public.qh_action(m,'admin.moderate',jsonb_build_object('kind','comment','id',comment_id,'decision','approve','reason','ok'),true);
 r:=public.qh_action(b,'posts.get',jsonb_build_object('id',p));if jsonb_array_length(r->'comments')<>1 then raise exception 'approved comment missing';end if;
 perform public.qh_action(b,'posts.comments',jsonb_build_object('id',p,'open',false));
 failed:=false;begin perform public.qh_action(o,'comments.save',jsonb_build_object('post_id',p,'body','Late'));exception when others then failed:=sqlerrm='not_found';end;
 if not failed then raise exception 'closed comments bypassed'; end if;
 perform public.qh_action(b,'blocks.toggle',jsonb_build_object('user_id',o));
 r:=public.qh_action(o,'posts.list');if jsonb_array_length(r->'posts')<>0 then raise exception 'blocked feed visible';end if;
 failed:=false;begin perform public.qh_action(o,'posts.get',jsonb_build_object('id',p));exception when others then failed:=sqlerrm='not_found';end;
 if not failed then raise exception 'blocked detail visible'; end if;
 r:=public.qh_action(b,'posts.get',jsonb_build_object('id',p));if jsonb_array_length(r->'comments')<>0 then raise exception 'blocked comments visible';end if;
 perform public.qh_action(m,'admin.user',jsonb_build_object('id',o,'status','muted','reason','test'),true);
 failed:=false;begin perform public.qh_action(o,'posts.save','{"title":"No","body":"Muted","category":"share","preference":"listen","submit":true}');exception when others then failed:=sqlerrm='muted';end;
 if not failed then raise exception 'muted posting bypassed'; end if;
 perform public.qh_action(a,'admin.user',jsonb_build_object('id',o,'status','banned','reason','test'),true);
 failed:=false;begin perform public.qh_action(o,'posts.list');exception when others then failed:=sqlerrm='forbidden';end;
 if not failed then raise exception 'banned user accepted'; end if;
 failed:=false;begin perform public.qh_action(m,'admin.user',jsonb_build_object('id',o,'status','active','reason','test'),true);exception when others then failed:=sqlerrm='forbidden';end;
 if not failed then raise exception 'moderator reversed owner ban';end if;

 perform public.qh_action(a,'admin.ai.save','{"config":{"model":"test","base":"https://api.deepseek.com","provider":"deepseek","protocol":"openai"},"encrypted_key":{"v":1,"iv":"opaque","data":"SECRET_CIPHERTEXT"},"key_last4":"1234","enabled":true,"user_daily_limit":1,"global_daily_limit":2}',true);
 r:=public.qh_action(b,'me');if r::text like '%SECRET%' or r::text like '%base%' or r::text like '%key_last4%' then raise exception 'config leaked through me';end if;
 r:=public.qh_action(a,'admin.ai.get','{}',true);if r::text like '%SECRET%' or r::text like '%encrypted_key%' then raise exception 'ciphertext returned to admin';end if;
 perform public.qh_reserve_ai(b);
 failed:=false;begin perform public.qh_reserve_ai(b);exception when others then failed:=sqlerrm='quota_exceeded';end;
 if not failed then raise exception 'user quota bypass';end if;
 perform public.qh_reserve_ai(m);
 failed:=false;begin perform public.qh_reserve_ai(a);exception when others then failed:=sqlerrm='quota_exceeded';end;
 if not failed then raise exception 'global quota bypass';end if;
 if (select sum(used) from public.qh_usage)<>2 then raise exception 'failed quota reservation changed usage';end if;
 r:=public.qh_action(a,'admin.usage','{}',true);
 if (r->>'total')::integer<>2 or jsonb_array_length(r->'users')<>2 then raise exception 'usage totals wrong'; end if;
 if not exists(select 1 from jsonb_array_elements(r->'users') x where x->>'nickname'='member' and (x->>'used')::integer=1) then raise exception 'usage member join wrong'; end if;
 if not exists(select 1 from public.qh_audit where action='ai.save') then raise exception 'audit absent';end if;
 if exists(select 1 from public.qh_audit where reason like '%SECRET_CIPHERTEXT%' or reason like '%Approved body%') then raise exception 'sensitive audit data';end if;
end $$;

-- Every role uses AI review. Exact job identity prevents delayed decisions from publishing edits.
do $$ declare a uuid:='11111111-1111-4111-8111-111111111111';m uuid:='33333333-3333-4333-8333-333333333333';
 r jsonb;pid uuid;jid uuid;newjid uuid;cid uuid;fields jsonb:='{"title":"Owner post","body":"Version one","category":"share","preference":"listen","submit":true}';denied boolean;
begin
 update public.qh_ai_settings set global_daily_limit=100,user_daily_limit=100;
 r:=public.qh_action(a,'posts.save',fields);pid:=(r->>'id')::uuid;jid:=(r->>'moderation_job_id')::uuid;
 if jid is null or (select status from public.qh_posts where id=pid)<>'pending' then raise exception 'owner bypassed AI review';end if;
 perform public.qh_claim_moderation(a,jid);
 r:=public.qh_complete_moderation(a,jid,'approve','通过','[]','v1','test');
 if r->>'status'<>'published' then raise exception 'AI approval failed';end if;
 r:=public.qh_action(a,'posts.save',fields||jsonb_build_object('id',pid,'body','Revision'));jid:=(r->>'moderation_job_id')::uuid;
 perform public.qh_claim_moderation(a,jid);
 perform public.qh_action(a,'posts.save',fields||jsonb_build_object('id',pid,'body','Private draft','submit',false));
 r:=public.qh_complete_moderation(a,jid,'approve','通过','[]','v1','test');
 if (r->>'applied')::boolean or (select body from public.qh_posts where id=pid)<>'Version one' then raise exception 'stale AI result published draft';end if;
 r:=public.qh_action(a,'posts.save',fields||jsonb_build_object('id',pid,'body','Revision two'));jid:=(r->>'moderation_job_id')::uuid;
 perform public.qh_claim_moderation(a,jid);
 r:=public.qh_action(a,'posts.save',fields||jsonb_build_object('id',pid,'body','Revision three'));newjid:=(r->>'moderation_job_id')::uuid;
 r:=public.qh_complete_moderation(a,jid,'approve','通过','[]','v1','test');
 if (r->>'applied')::boolean then raise exception 'old version approved newer text';end if;
 perform public.qh_claim_moderation(a,newjid);
 perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','post','id',pid,'decision','reject','reason','人工拒绝'),true);
 r:=public.qh_complete_moderation(a,newjid,'approve','通过','[]','v1','test');
 if (r->>'applied')::boolean or (select revision_status from public.qh_posts where id=pid)<>'rejected' then raise exception 'AI overrode human';end if;
 perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','post','id',pid,'decision','approve','reason','站长复核放行'),true);
 if (select body from public.qh_posts where id=pid)<>'Revision three' then raise exception 'owner review failed';end if;
 r:=public.qh_action(a,'comments.save',jsonb_build_object('post_id',pid,'body','reply'));cid:=(r->>'id')::uuid;jid:=(r->>'moderation_job_id')::uuid;
 perform public.qh_claim_moderation(a,jid);
 perform public.qh_complete_moderation(a,jid,'reject','需修改','["3"]','v1','test');
 perform public.qh_action(a,'appeals.create',jsonb_build_object('comment_id',cid,'reason','请求复核'));
 if not exists(select 1 from public.qh_appeals where comment_id=cid) then raise exception 'comment appeal absent';end if;
 r:=public.qh_action(a,'posts.save',fields);pid:=(r->>'id')::uuid;jid:=(r->>'moderation_job_id')::uuid;
 update public.qh_ai_settings set enabled=false;
 denied:=false;begin perform public.qh_claim_moderation(a,jid);exception when others then denied:=sqlerrm='not_configured';end;
 if not denied or (select status from public.qh_moderation_jobs where id=jid)<>'queued' then raise exception 'disabled AI ran moderation';end if;
 update public.qh_ai_settings set enabled=true;
 perform public.qh_complete_moderation(a,jid,'error','审核暂不可用','[]','v1','test');
 if (select status from public.qh_posts where id=pid)<>'pending' then raise exception 'error failed open';end if;
 denied:=false;begin perform public.qh_claim_moderation(m,jid);exception when others then denied:=sqlerrm='not_found';end;
 if not denied then raise exception 'other author claimed job';end if;
end $$;

-- Actual low-privilege execution: grants must fail, regardless of RLS policy defaults.
do $$
declare a uuid:='11111111-1111-4111-8111-111111111111';b uuid:='22222222-2222-4222-8222-222222222222';m uuid:='33333333-3333-4333-8333-333333333333';
 r jsonb;pid uuid;cid uuid;aid uuid;reportid uuid;denied boolean;
 fields jsonb:='{"title":"Resolution","body":"Original appeal content","category":"share","preference":"listen","submit":true}';
begin
 update public.qh_profiles set status='active',admission_status='approved' where id in (a,b,m);
 r:=public.qh_action(b,'posts.save',fields);pid:=(r->>'id')::uuid;
 perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','post','id',pid,'decision','reject','reason','需复核'),true);
 r:=public.qh_action(b,'appeals.create',jsonb_build_object('post_id',pid,'reason','请求人工复核'));aid:=(r->>'id')::uuid;
 r:=public.qh_action(a,'admin.queue','{}',true);
 if not exists(select 1 from jsonb_array_elements(r->'appeals') e where e->>'id'=aid::text and e->>'target_body'='Original appeal content' and (e->>'can_restore')::boolean) then raise exception 'appeal queue missing original content';end if;
 denied:=false;begin perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','appeal','id',aid,'decision','restore','reason','恢复'),false);exception when others then denied:=sqlerrm='mfa_required';end;
 if not denied or (select status from public.qh_appeals where id=aid)<>'open' or (select status from public.qh_posts where id=pid)<>'rejected' then raise exception 'restore bypassed MFA';end if;
 perform public.qh_action(m,'admin.moderate',jsonb_build_object('kind','appeal','id',aid,'decision','restore','reason','复核通过并恢复'),true);
 if (select status from public.qh_posts where id=pid)<>'published' or (select status from public.qh_appeals where id=aid)<>'resolved' then raise exception 'post restoration not atomic';end if;
 r:=public.qh_action(b,'comments.save',jsonb_build_object('post_id',pid,'body','Appealed reply'));cid:=(r->>'id')::uuid;
 perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','comment','id',cid,'decision','reject','reason','需复核'),true);
 r:=public.qh_action(b,'appeals.create',jsonb_build_object('comment_id',cid,'reason','复核回应'));aid:=(r->>'id')::uuid;
 perform public.qh_action(m,'admin.moderate',jsonb_build_object('kind','appeal','id',aid,'decision','restore','reason','回应复核通过'),true);
 if (select status from public.qh_comments where id=cid)<>'published' or (select status from public.qh_appeals where id=aid)<>'resolved' then raise exception 'reply restoration not atomic';end if;
 r:=public.qh_action(b,'reports.create',jsonb_build_object('post_id',pid,'reason','请求下架'));reportid:=(r->>'id')::uuid;
 perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','report','id',reportid,'decision','hide','reason','下架并结案'),true);
 if (select status from public.qh_posts where id=pid)<>'hidden' or (select status from public.qh_reports where id=reportid)<>'resolved' then raise exception 'report resolution not atomic';end if;
 r:=public.qh_action(b,'appeals.create',jsonb_build_object('post_id',pid,'reason','请求恢复'));aid:=(r->>'id')::uuid;
 perform public.qh_action(b,'posts.save',fields||jsonb_build_object('id',pid,'body','New private draft','submit',false));
 denied:=false;begin perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','appeal','id',aid,'decision','restore','reason','恢复'),true);exception when others then denied:=sqlerrm in ('content_changed','not_found');end;
 if not denied or (select status from public.qh_posts where id=pid)<>'draft' or (select status from public.qh_appeals where id=aid)<>'open' then raise exception 'old appeal exposed new draft';end if;
 r:=public.qh_action(m,'posts.save',fields);pid:=(r->>'id')::uuid;
 perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','post','id',pid,'decision','approve','reason','发布'),true);
 r:=public.qh_action(b,'reports.create',jsonb_build_object('post_id',pid,'reason','复核'));reportid:=(r->>'id')::uuid;
 denied:=false;begin perform public.qh_action(m,'admin.moderate',jsonb_build_object('kind','report','id',reportid,'decision','hide','reason','自己下架'),true);exception when others then denied:=sqlerrm='self_moderation';end;
 if not denied or (select status from public.qh_posts where id=pid)<>'published' or (select status from public.qh_reports where id=reportid)<>'open' then raise exception 'failed moderation partially resolved report';end if;
 if has_function_privilege('service_role','public.qh_action_before_resolution(uuid,text,jsonb,boolean)','execute') or has_function_privilege('authenticated','public.qh_review_snapshot(uuid,uuid)','execute') then raise exception 'private resolution function exposed';end if;
end $$;

-- Audit regressions: MFA reads, every browser table grant, erasure and shared quotas.
do $$ declare a uuid:='11111111-1111-4111-8111-111111111111';m uuid:='33333333-3333-4333-8333-333333333333';
 x uuid:='55555555-5555-4555-8555-555555555555';y uuid:='66666666-6666-4666-8666-666666666666';z uuid:='77777777-7777-4777-8777-777777777777';
 p uuid;q uuid;j uuid;c uuid;r jsonb;denied boolean;tab record;role_name text;priv text;found_text boolean;action_name text;i integer;
 fields jsonb:='{"title":"Erasure test","body":"ERASE-ME-UNIQUE-801","category":"share","preference":"listen","submit":true}';
begin
 -- Every browser table grant is checked, including newly added tables.
 if to_regprocedure('public.rls_auto_enable()') is not null and
  (has_function_privilege('anon','public.rls_auto_enable()','execute') or has_function_privilege('authenticated','public.rls_auto_enable()','execute')) then
  raise exception 'administrative RLS event trigger is callable by browser roles';
 end if;
 for tab in select tablename from pg_tables where schemaname='public' and tablename like 'qh_%' loop
  foreach role_name in array array['anon','authenticated'] loop
   foreach priv in array array['SELECT','INSERT','UPDATE','DELETE'] loop
    if has_table_privilege(role_name,format('public.%I',tab.tablename),priv) then raise exception 'browser table privilege: % % %',role_name,tab.tablename,priv;end if;
   end loop;
  end loop;
 end loop;
 foreach action_name in array array['admin.queue','admin.applications','admin.users','admin.audit','admin.ai.get','admin.usage','admin.invites.list'] loop
  denied:=false;begin perform public.qh_action(a,action_name,'{}',false);exception when others then denied:=sqlerrm='mfa_required';end;
  if not denied then raise exception 'read action bypassed MFA: %',action_name;end if;
  denied:=false;begin perform public.qh_action(a,action_name,'{}',null);exception when others then denied:=sqlerrm='mfa_required';end;
  if not denied then raise exception 'NULL assurance bypassed MFA: %',action_name;end if;
 end loop;
 denied:=false;begin perform public.qh_action(m,'admin.purge',jsonb_build_object('id',y,'reason','request'),true);exception when others then denied:=sqlerrm='forbidden';end;
 if not denied then raise exception 'moderator can erase accounts';end if;
 denied:=false;begin perform public.qh_action(a,'admin.purge',jsonb_build_object('id',y,'reason','request'),false);exception when others then denied:=sqlerrm='mfa_required';end;
 if not denied then raise exception 'purge bypassed MFA';end if;

end $$;

do $$ declare a uuid:='11111111-1111-4111-8111-111111111111';x uuid:='55555555-5555-4555-8555-555555555555';y uuid:='66666666-6666-4666-8666-666666666666';z uuid:='77777777-7777-4777-8777-777777777777';
 p uuid;q uuid;c uuid;j uuid;r jsonb;tab record;found_text boolean;denied boolean;
 fields jsonb:='{"title":"Erasure test","body":"ERASE-ME-UNIQUE-801","category":"share","preference":"listen","submit":true}';
begin
 -- Dedicated disposable identities avoid modifying the earlier fixtures.
 insert into auth.users(id,email) values(x,'erase-x@example.invalid'),(y,'erase-y@example.invalid'),(z,'purge-z@example.invalid') on conflict do nothing;
 update public.qh_profiles set admission_status='approved' where id in (x,y,z);
 update public.qh_ai_settings set user_daily_limit=100,global_daily_limit=1000;
 r:=public.qh_action(y,'posts.save',fields||jsonb_build_object('body','Pending erasure marker'));q:=(r->>'id')::uuid;
 perform public.qh_action(y,'posts.delete',jsonb_build_object('id',q));
 if exists(select 1 from public.qh_moderation_jobs where target_id=q) then raise exception 'pending deletion left moderation job';end if;
 r:=public.qh_action(x,'posts.save',fields);p:=(r->>'id')::uuid;
 perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','post','id',p,'decision','approve','reason','approved'),true);
 r:=public.qh_action(y,'comments.save',jsonb_build_object('post_id',p,'body','PENDING-COMMENT-ERASURE-804'));c:=(r->>'id')::uuid;
 perform public.qh_action(y,'comments.delete',jsonb_build_object('id',c));
 for tab in select tablename from pg_tables where schemaname='public' and tablename like 'qh_%' loop
  execute format('select exists(select 1 from public.%I t where position($1 in to_jsonb(t)::text)>0)',tab.tablename) into found_text using 'PENDING-COMMENT-ERASURE-804';
  if found_text then raise exception 'pending comment persists in %',tab.tablename;end if;
 end loop;
 r:=public.qh_action(y,'comments.save',jsonb_build_object('post_id',p,'body','ERASE-ME-UNIQUE-802'));c:=(r->>'id')::uuid;
 perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','comment','id',c,'decision','reject','reason','review'),true);
 perform public.qh_action(y,'appeals.create',jsonb_build_object('comment_id',c,'reason','review'));
 insert into public.qh_audit(action,target_id,reason) values('review.fixture',c,'ERASE-ME-UNIQUE-802');
 denied:=false;begin perform public.qh_action(x,'comments.delete',jsonb_build_object('id',c));exception when others then denied:=sqlerrm='not_found';end;
 if not denied then raise exception 'another author deleted comment';end if;
 perform public.qh_action(y,'comments.delete',jsonb_build_object('id',c));
 for tab in select tablename from pg_tables where schemaname='public' and tablename like 'qh_%' loop
  execute format('select exists(select 1 from public.%I t where position($1 in to_jsonb(t)::text)>0)',tab.tablename) into found_text using 'ERASE-ME-UNIQUE-802';
  if found_text then raise exception 'deleted comment persists in %',tab.tablename;end if;
 end loop;
 perform public.qh_action(y,'reports.create',jsonb_build_object('post_id',p,'reason','review'));
 perform public.qh_action(x,'posts.save',fields||jsonb_build_object('id',p,'body','ERASE-ME-UNIQUE-803'));
 perform public.qh_action(a,'admin.moderate',jsonb_build_object('kind','post','id',p,'decision','reject','reason','review'),true);
 perform public.qh_action(x,'appeals.create',jsonb_build_object('post_id',p,'reason','review'));
 insert into public.qh_audit(action,target_id,reason) values('review.fixture',p,'ERASE-ME-UNIQUE-803');
 r:=public.qh_action(y,'posts.save',fields||jsonb_build_object('body','Unrelated content'));q:=(r->>'id')::uuid;
 insert into public.qh_moderation_jobs(author_id,kind,target_id,content,context) values(y,'post',q,'{}','{"post":{"body":"ERASE-ME-UNIQUE-801"}}');
 perform public.qh_action(x,'posts.delete',jsonb_build_object('id',p));
 for tab in select tablename from pg_tables where schemaname='public' and tablename like 'qh_%' loop
  execute format('select exists(select 1 from public.%I t where to_jsonb(t)::text like $1)',tab.tablename) into found_text using '%ERASE-ME-UNIQUE-%';
  if found_text then raise exception 'deleted post persists in %',tab.tablename;end if;
 end loop;
 -- The full author history must allow actual Auth deletion, including attribution.
 r:=public.qh_action(x,'posts.save',fields||jsonb_build_object('body','Account erasure text'));p:=(r->>'id')::uuid;
 insert into public.qh_invites(code_hash,code_hint,label,max_uses,created_by) values(repeat('f',64),'FFFF','author fixture',1,x);
 delete from auth.users where id=x;
 if exists(select 1 from public.qh_profiles where id=x) or exists(select 1 from public.qh_posts where author_id=x) or exists(select 1 from public.qh_moderation_jobs where author_id=x) then raise exception 'Auth deletion left owned data';end if;
 if not exists(select 1 from public.qh_invites where code_hint='FFFF' and created_by is null) then raise exception 'attribution should be nullable';end if;
 perform public.qh_action(a,'admin.purge',jsonb_build_object('id',z,'reason','confirmed request'),true);
 if exists(select 1 from auth.users where id=z) then raise exception 'admin purge failed';end if;

 -- The last allowed shared reservation blocks chat AND moderation afterward.
 r:=public.qh_action(y,'posts.save',fields||jsonb_build_object('body','Shared quota'));j:=(r->>'moderation_job_id')::uuid;
 update public.qh_ai_settings set user_daily_limit=1,global_daily_limit=1000;
 perform public.qh_reserve_ai(y);
 denied:=false;begin perform public.qh_claim_moderation(y,j);exception when others then denied:=sqlerrm='quota_exceeded';end;
 if not denied then raise exception 'moderation bypassed shared user quota';end if;
 denied:=false;begin perform public.qh_reserve_ai(y);exception when others then denied:=sqlerrm='quota_exceeded';end;
 if not denied then raise exception 'chat bypassed shared user quota';end if;
 update public.qh_ai_settings set user_daily_limit=100,global_daily_limit=(select used from public.qh_global_usage where day=(now() at time zone 'UTC')::date);
 denied:=false;begin perform public.qh_claim_moderation(y,j);exception when others then denied:=sqlerrm='quota_exceeded';end;
 if not denied then raise exception 'moderation bypassed shared global quota';end if;
 denied:=false;begin perform public.qh_reserve_ai(a);exception when others then denied:=sqlerrm='quota_exceeded';end;
 if not denied then raise exception 'chat bypassed shared global quota';end if;
 update public.qh_ai_settings set global_daily_limit=1000;
 perform public.qh_claim_moderation(y,j);
 perform public.qh_complete_moderation(y,j,'approve','approved','[]','test','test');
 if exists(select 1 from public.qh_audit where target_id=(select target_id from public.qh_moderation_jobs where id=j) and action='moderation.ai.approve' and actor_id is not null) then raise exception 'AI actor is not system';end if;
 update public.qh_moderation_jobs set created_at=now()-interval '31 days' where id=j;
 update public.qh_maintenance set last_run='-infinity';perform public.qh_cleanup();
 if exists(select 1 from public.qh_moderation_jobs where id=j and (content<>'{}' or context<>'{}')) then raise exception 'snapshot retention failed';end if;
end $$;

do $$ declare a uuid:='11111111-1111-4111-8111-111111111111';r jsonb;s jsonb;i integer;denied boolean;begin
 -- Pagination reaches older records and uses a non-overlapping 20-item window.
 for i in 1..45 loop
  insert into auth.users(id,email) values(gen_random_uuid(),'pagination@example.invalid');
  insert into public.qh_audit(action) values('pagination');
 end loop;
 r:=public.qh_action(a,'admin.users','{"page":0}',true);s:=public.qh_action(a,'admin.users','{"page":1}',true);
 if jsonb_array_length(r->'users')<>20 or not(r->>'hasMore')::boolean or jsonb_array_length(s->'users')<>20 then raise exception 'user pagination failed';end if;
 if exists(select 1 from jsonb_array_elements(r->'users') x join jsonb_array_elements(s->'users') y on x->>'id'=y->>'id') then raise exception 'user pages overlap';end if;
 r:=public.qh_action(a,'admin.audit','{"page":0}',true);s:=public.qh_action(a,'admin.audit','{"page":1}',true);
 if jsonb_array_length(r->'events')<>20 or not(r->>'hasMore')::boolean then raise exception 'audit pagination failed';end if;
 if exists(select 1 from jsonb_array_elements(r->'events') x join jsonb_array_elements(s->'events') y on x->>'id'=y->>'id') then raise exception 'audit pages overlap';end if;
 -- A nearly elapsed old window does not reset the full burst budget.
 delete from public.qh_rate_limits where user_id=a and bucket='test-bucket';
 perform public.qh_rate(a,'test-bucket',2,60);perform public.qh_rate(a,'test-bucket',2,60);
 update public.qh_rate_limits set window_start=now()-interval '1 second' where user_id=a and bucket='test-bucket';
 denied:=false;begin perform public.qh_rate(a,'test-bucket',2,60);exception when others then denied:=sqlerrm='rate_limit';end;
 if not denied then raise exception 'rate boundary resets token bucket';end if;
end $$;

set local role authenticated;
do $$ declare denied boolean; begin
 denied:=false;begin perform * from public.qh_ai_settings;exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'authenticated read settings';end if;
 denied:=false;begin perform public.qh_action('11111111-1111-4111-8111-111111111111','admin.ai.get');exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'authenticated impersonated owner';end if;
 denied:=false;begin perform public.qh_claim_moderation('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111');exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'authenticated claimed service job';end if;
 denied:=false;begin perform * from public.qh_moderation_jobs;exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'authenticated read private moderation context';end if;
end $$;
reset role;
rollback;
