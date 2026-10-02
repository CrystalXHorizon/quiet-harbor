-- Run after migrations on a disposable/local Supabase database: psql ... -f this-file.
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
 r:=public.qh_action(a,'admin.queue');
 if r <> '{"posts":[],"comments":[],"reports":[],"appeals":[]}'::jsonb then raise exception 'unexpected empty queue'; end if;
 r:=public.qh_action(a,'admin.usage');
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
 r:=public.qh_action(m,'admin.queue');
 if jsonb_array_length(r->'comments')<>1 or jsonb_array_length(r->'reports')<>1 or jsonb_array_length(r->'appeals')<>1 then raise exception 'populated moderation queue incomplete'; end if;
 if r->'reports'->0->>'target_body'<>'Approved body' or r->'appeals'->0->>'target_title'<>'Original' then raise exception 'queue joined wrong record'; end if;
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
 r:=public.qh_action(a,'admin.ai.get');if r::text like '%SECRET%' or r::text like '%encrypted_key%' then raise exception 'ciphertext returned to admin';end if;
 perform public.qh_reserve_ai(b);
 failed:=false;begin perform public.qh_reserve_ai(b);exception when others then failed:=sqlerrm='quota_exceeded';end;
 if not failed then raise exception 'user quota bypass';end if;
 perform public.qh_reserve_ai(m);
 failed:=false;begin perform public.qh_reserve_ai(a);exception when others then failed:=sqlerrm='quota_exceeded';end;
 if not failed then raise exception 'global quota bypass';end if;
 if (select sum(used) from public.qh_usage)<>2 then raise exception 'failed quota reservation changed usage';end if;
 r:=public.qh_action(a,'admin.usage');
 if (r->>'total')::integer<>2 or jsonb_array_length(r->'users')<>2 then raise exception 'usage totals wrong'; end if;
 if not exists(select 1 from jsonb_array_elements(r->'users') x where x->>'nickname'='member' and (x->>'used')::integer=1) then raise exception 'usage member join wrong'; end if;
 if not exists(select 1 from public.qh_audit where action='ai.save') then raise exception 'audit absent';end if;
 if exists(select 1 from public.qh_audit where reason like '%SECRET_CIPHERTEXT%' or reason like '%Approved body%') then raise exception 'sensitive audit data';end if;
end $$;

-- Owner publishing uses the stored role, preserves drafts, and cannot edit another author.
do $$ declare a uuid:='11111111-1111-4111-8111-111111111111'; b uuid:='22222222-2222-4222-8222-222222222222'; m uuid:='33333333-3333-4333-8333-333333333333';
 r jsonb; pid uuid; fields jsonb:='{"title":"Owner post","body":"Version one","category":"share","preference":"listen"}'; denied boolean;
begin
 r:=public.qh_action(a,'posts.save',fields||'{"submit":false}');pid:=(r->>'id')::uuid;
 if (select status from public.qh_posts where id=pid)<>'draft' then raise exception 'owner draft published'; end if;
 perform public.qh_action(a,'posts.save',fields||jsonb_build_object('id',pid,'submit',true));
 if (select status from public.qh_posts where id=pid)<>'published' then raise exception 'owner post awaits review'; end if;
 perform public.qh_action(a,'posts.save',fields||jsonb_build_object('id',pid,'body','Version two','submit',true));
 if (select body from public.qh_posts where id=pid)<>'Version two' then raise exception 'owner edit awaits review'; end if;
 perform public.qh_action(a,'posts.save',fields||jsonb_build_object('id',pid,'body','Private draft','submit',false));
 if (select body from public.qh_posts where id=pid)<>'Version two' or (select revision_status from public.qh_posts where id=pid)<>'draft' then raise exception 'owner draft revision leaked'; end if;
 perform public.qh_action(a,'posts.save',fields||jsonb_build_object('id',pid,'body','Final','submit',true));
 if (select pending_revision from public.qh_posts where id=pid) is not null then raise exception 'owner stale revision'; end if;
 denied:=false;begin perform public.qh_action(b,'posts.save',fields||jsonb_build_object('id',pid,'submit',true));exception when others then denied:=sqlerrm='not_found';end;
 if not denied then raise exception 'other author edited owner post'; end if;
 r:=public.qh_action(m,'posts.save',fields||'{"submit":true,"role":"owner"}');
 if (select status from public.qh_posts where id=(r->>'id')::uuid)<>'pending' then raise exception 'moderator bypassed review'; end if;
 r:=public.qh_action(b,'posts.save',fields||'{"submit":true,"role":"owner"}');
 if (select status from public.qh_posts where id=(r->>'id')::uuid)<>'pending' then raise exception 'member bypassed review'; end if;
 if not exists(select 1 from public.qh_audit where action='posts.owner_publish' and target_id=pid) then raise exception 'owner publication audit absent'; end if;
end $$;

-- Actual low-privilege execution: grants must fail, regardless of RLS policy defaults.
set local role authenticated;
do $$ declare denied boolean; begin
 denied:=false;begin perform * from public.qh_ai_settings;exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'authenticated read settings';end if;
 denied:=false;begin perform public.qh_action('11111111-1111-4111-8111-111111111111','admin.ai.get');exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'authenticated impersonated owner';end if;
end $$;
reset role;
rollback;
