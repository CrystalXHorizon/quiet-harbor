begin;
-- Audit remediation. Existing migrations remain immutable.
alter default privileges in schema public revoke all on tables from anon,authenticated;
alter default privileges revoke all on tables from anon,authenticated;
alter default privileges in schema public revoke execute on functions from public,anon,authenticated;
alter default privileges revoke execute on functions from public,anon,authenticated;
-- Supabase's RLS event trigger is administrative, never a browser RPC.
do $$ begin
 if exists(select 1 from pg_proc where oid=to_regprocedure('public.rls_auto_enable()') and prorettype='event_trigger'::regtype) then
  revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
 end if;
end $$;

-- Content follows its owner. Administrative attribution survives as NULL.
do $$ declare f record;col text;rule text;begin
 for f in select c.oid,c.conname,c.conrelid,c.confrelid,c.conkey,pg_get_constraintdef(c.oid) def
  from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
  where c.contype='f' and n.nspname='public' and t.relname like 'qh_%'
 loop
  select attname into col from pg_attribute where attrelid=f.conrelid and attnum=f.conkey[1];
  rule:=case when col in ('reviewed_by','created_by') then 'SET NULL' else 'CASCADE' end;
  if rule='SET NULL' then execute format('alter table %s alter column %I drop not null',f.conrelid::regclass,col);end if;
  execute format('alter table %s drop constraint %I',f.conrelid::regclass,f.conname);
  execute format('alter table %s add constraint %I %s on delete %s',f.conrelid::regclass,f.conname,regexp_replace(f.def,' ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION|SET DEFAULT)',''),rule);
 end loop;
end $$;
alter table public.qh_posts add constraint qh_posts_job_fk foreign key(moderation_job_id) references public.qh_moderation_jobs(id) on delete set null;
alter table public.qh_comments add constraint qh_comments_job_fk foreign key(moderation_job_id) references public.qh_moderation_jobs(id) on delete set null;
alter table public.qh_notifications add constraint qh_notifications_post_fk foreign key(post_id) references public.qh_posts(id) on delete cascade;
alter table public.qh_notifications add constraint qh_notifications_comment_fk foreign key(comment_id) references public.qh_comments(id) on delete cascade;

create index qh_post_queue on public.qh_posts(status,updated_at);
create index qh_comment_queue on public.qh_comments(status,created_at);
create index qh_report_queue on public.qh_reports(status,created_at);
create index qh_appeal_queue on public.qh_appeals(status,created_at);
create index qh_profile_order on public.qh_profiles(created_at desc,id);
create index qh_moderation_retention on public.qh_moderation_jobs(created_at);

create function public.qh_erase_content() returns trigger language plpgsql security definer set search_path='' as $$
declare texts text[];begin
 texts:=array[old.body];
 if tg_table_name='qh_posts' then texts:=texts||array[old.pending_revision->>'body'];end if;
 -- A different member's moderation context can contain this content as well.
 update public.qh_moderation_jobs j set context='{}',reason='' where j.context->'post'->>'body'=any(texts)
  or exists(select 1 from jsonb_array_elements(coalesce(j.context->'comments','[]')) c where c->>'body'=any(texts));
 update public.qh_audit set reason='' where target_id=old.id
  or target_id in (select id from public.qh_reports where post_id=old.id or comment_id=old.id)
  or target_id in (select id from public.qh_appeals where post_id=old.id or comment_id=old.id);
 return old;
end $$;
create trigger qh_erase_post before delete on public.qh_posts for each row execute function public.qh_erase_content();
create trigger qh_erase_comment before delete on public.qh_comments for each row execute function public.qh_erase_content();
-- Remove the referenced job only after its parent disappears. SET NULL must not
-- update a tuple that is currently being deleted by a BEFORE trigger.
create function public.qh_erase_jobs() returns trigger language plpgsql security definer set search_path='' as $$
begin
 delete from public.qh_moderation_jobs where target_id=old.id and kind=case when tg_table_name='qh_posts' then 'post' else 'comment' end;
 return old;
end $$;
revoke all on function public.qh_erase_jobs() from public,anon,authenticated,service_role;
create trigger qh_erase_post_jobs after delete on public.qh_posts for each row execute function public.qh_erase_jobs();
create trigger qh_erase_comment_jobs after delete on public.qh_comments for each row execute function public.qh_erase_jobs();
-- Clean historical soft deletions through the same erasure triggers.
delete from public.qh_comments where deleted_at is not null;
delete from public.qh_posts where deleted_at is not null;
create function public.qh_erase_account_attribution() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.qh_audit set actor_id=null,reason='' where actor_id=old.id;
 update public.qh_audit set target_id=null,reason='' where target_id=old.id;
 return old;
end $$;
create trigger qh_erase_account before delete on public.qh_profiles for each row execute function public.qh_erase_account_attribution();

-- Lazy daily maintenance and a cron hook when pg_cron is installed.
create table public.qh_maintenance(id boolean primary key default true check(id),last_run timestamptz not null default '-infinity');
insert into public.qh_maintenance(id) values(true);
create function public.qh_cleanup() returns void language plpgsql security definer set search_path='' as $$
begin
 update public.qh_maintenance set last_run=now() where id=true and last_run<now()-interval '1 day';
 if not found then return;end if;
 update public.qh_moderation_jobs set content='{}',context='{}',reason='',status=case when status in ('queued','running') then 'superseded' else status end
  where created_at<now()-interval '30 days' and (content<>'{}' or context<>'{}' or reason<>'');
 update public.qh_appeals set content_snapshot=null where created_at<now()-interval '30 days' and content_snapshot is not null;
 update public.qh_reports set content_snapshot=null where created_at<now()-interval '30 days' and content_snapshot is not null;
 delete from public.qh_audit where created_at<now()-interval '180 days';
 delete from public.qh_usage where day<(now() at time zone 'UTC')::date-90;
 delete from public.qh_global_usage where day<(now() at time zone 'UTC')::date-90;
 delete from public.qh_moderation_usage where day<(now() at time zone 'UTC')::date-90;
 delete from public.qh_rate_limits where window_start<now()-interval '1 day';
 delete from public.qh_notifications where created_at<now()-interval '90 days';
end $$;

-- A token bucket prevents a fixed-window boundary from doubling the burst.
alter table public.qh_rate_limits add column tokens double precision;
create or replace function public.qh_rate(actor uuid,b text,capacity integer,seconds integer) returns void language plpgsql set search_path='' as $$
declare r public.qh_rate_limits;available double precision;begin
 insert into public.qh_rate_limits(user_id,bucket,window_start,used,tokens) values(actor,b,now(),0,capacity) on conflict do nothing;
 select * into r from public.qh_rate_limits where user_id=actor and bucket=b for update;
 available:=least(capacity,coalesce(r.tokens,greatest(0,capacity-r.used))+greatest(0,extract(epoch from now()-r.window_start))*capacity/seconds);
 if available<1 then raise exception 'rate_limit';end if;
 update public.qh_rate_limits set tokens=available-1,window_start=now(),used=used+1 where user_id=actor and bucket=b;
end $$;

-- Each reservation covers ONE provider request, regardless of the pipeline.
alter table public.qh_usage add column provider_calls integer not null default 0;
alter table public.qh_usage add column chat_turns integer not null default 0;
alter table public.qh_usage add column moderation_used integer not null default 0;
create table public.qh_global_usage(day date primary key,used bigint not null default 0);
-- Preserve an upper bound for usage already charged under the old turn semantics.
update public.qh_usage set chat_turns=used,used=used*3;
insert into public.qh_global_usage(day,used) select day,sum(used) from public.qh_usage group by day;
insert into public.qh_global_usage(day,used) select day,used from public.qh_moderation_usage on conflict(day) do update set used=public.qh_global_usage.used+excluded.used;
create function public.qh_reserve_model(actor uuid,kind text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qh_profiles;s public.qh_ai_settings;n integer;total bigint;d date:=(now() at time zone 'UTC')::date;begin
 select * into u from public.qh_profiles where id=actor for update;
 if u.id is null or u.status='banned' then raise exception 'forbidden';end if;
 if u.admission_status<>'approved' then raise exception 'admission_required';end if;
 if kind not in ('chat','moderation','test') then raise exception 'validation';end if;
 if kind='test' and u.role<>'owner' then raise exception 'forbidden';end if;
 if kind='chat' then perform public.qh_rate(actor,'chat_calls',15,60);end if;
 select * into s from public.qh_ai_settings where id=true for update;
 if kind<>'test' and (not s.enabled or s.encrypted_key is null or s.config='{}') then raise exception 'not_configured';end if;
 select used into n from public.qh_usage where day=d and user_id=actor;
 insert into public.qh_global_usage(day) values(d) on conflict do nothing;
 select used into total from public.qh_global_usage where day=d for update;
 if coalesce(n,0)>=s.user_daily_limit or total>=s.global_daily_limit then raise exception 'quota_exceeded';end if;
 insert into public.qh_usage(day,user_id,used,moderation_used) values(d,actor,1,case when kind='moderation' then 1 else 0 end)
  on conflict(day,user_id) do update set used=public.qh_usage.used+1,moderation_used=public.qh_usage.moderation_used+excluded.moderation_used;
 update public.qh_global_usage set used=used+1 where day=d;
 return jsonb_build_object('config',s.config,'encrypted_key',s.encrypted_key);
end $$;
create or replace function public.qh_reserve_ai(actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin return public.qh_reserve_model(actor,'chat');end $$;
create function public.qh_record_ai_call(actor uuid,kind text,start_turn boolean default false) returns void language plpgsql security definer set search_path='' as $$
begin
 update public.qh_usage set provider_calls=provider_calls+1,chat_turns=chat_turns+case when kind='chat' and start_turn then 1 else 0 end
  where user_id=actor and day=(now() at time zone 'UTC')::date and provider_calls<used;
 if not found then raise exception 'quota_exceeded';end if;
end $$;

create or replace function public.qh_action_admitted(actor uuid, action text, payload jsonb default '{}', aal2 boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qh_profiles; target public.qh_profiles; p public.qh_posts; c public.qh_comments; s public.qh_ai_settings;
 result jsonb; items jsonb; comments jsonb; rid uuid; pid uuid; flag boolean; decision text; why text; n integer;
 offset_n integer := greatest(0,least(coalesce((payload->>'page')::integer,0),1000))*20;
begin
 select * into u from public.qh_profiles where id=actor for update;
 if u.id is null then raise exception using errcode='P0001',message='unauthorized'; end if;
 perform public.qh_rate(actor,'api',120,60);
 select * into s from public.qh_ai_settings where id=true;
 if action='me' then
   return jsonb_build_object('profile',to_jsonb(u),'ai',jsonb_build_object('ready',s.enabled and s.encrypted_key is not null,'model',case when s.enabled then s.config->>'model' else null end),
    'usage',jsonb_build_object('used',coalesce((select used from public.qh_usage where user_id=actor and day=(now() at time zone 'UTC')::date),0),'limit',s.user_daily_limit));
 end if;
 if u.status='banned' then raise exception using errcode='P0001',message='forbidden'; end if;
 if action like 'admin.%' and (u.role not in ('moderator','owner') or u.status<>'active') then raise exception using errcode='P0001',message='forbidden'; end if;
 if action in ('admin.ai.get','admin.ai.save','admin.ai.test','admin.usage','admin.audit') and u.role<>'owner' then raise exception using errcode='P0001',message='forbidden'; end if;
 if action in ('admin.ai.save','admin.ai.test','admin.moderate','admin.user') then
   if aal2 is not true then raise exception using errcode='P0001',message='mfa_required'; end if;
 end if;
 -- Muting stops publication, but must not remove reporting/appeal or own-content controls.
 if action in ('posts.save','comments.save') and u.status<>'active' then raise exception using errcode='P0001',message='muted'; end if;
 if action in ('posts.save','comments.save','reports.create','appeals.create') then perform public.qh_rate(actor,'community',20,3600); end if;

 if action='profile.update' then
   update public.qh_profiles set nickname=trim(payload->>'nickname') where id=actor;
 elsif action='posts.list' then
   select coalesce(jsonb_agg(value),'[]') into items from (
    select public.qh_post_json(x,(payload->>'mine')::boolean is true) value from public.qh_posts x
    where x.deleted_at is null and not public.qh_blocked(actor,x.author_id)
    and (case when (payload->>'mine')::boolean is true then x.author_id=actor else x.status='published' end)
    and (payload->>'category' is null or x.category=payload->>'category')
    and (coalesce((payload->>'bookmarked')::boolean,false)=false or exists(select 1 from public.qh_bookmarks b where b.user_id=actor and b.post_id=x.id))
    order by x.created_at desc,x.id limit 21 offset offset_n
   ) listed;
   return jsonb_build_object('posts',case when jsonb_array_length(items)>20 then items-20 else items end,'hasMore',jsonb_array_length(items)>20);
 elsif action='posts.get' then
   select * into p from public.qh_posts where id=(payload->>'id')::uuid and deleted_at is null;
   if p.id is null or (p.status='draft' and p.author_id<>actor) or (p.status<>'published' and p.author_id<>actor and u.role='member') or (u.role='member' and public.qh_blocked(actor,p.author_id)) then raise exception using errcode='P0001',message='not_found'; end if;
   select coalesce(jsonb_agg(value),'[]') into comments from (
    select public.qh_comment_json(x) value from public.qh_comments x where x.post_id=p.id and x.deleted_at is null
    and (x.status='published' or x.author_id=actor or u.role in ('moderator','owner')) and not public.qh_blocked(actor,x.author_id)
    order by x.created_at limit 200
   ) list;
   return jsonb_build_object('post',public.qh_post_json(p,p.author_id=actor or (u.role in ('moderator','owner') and p.revision_status<>'draft')),'comments',comments,
    'bookmarked',exists(select 1 from public.qh_bookmarks where user_id=actor and post_id=p.id));
 elsif action='posts.save' then
   if char_length(trim(payload->>'title')) not between 1 and 120 or char_length(trim(payload->>'body')) not between 1 and 6000 or payload->>'category' not in ('share','advice','progress') or payload->>'preference' not in ('listen','advice') then raise exception using errcode='P0001',message='validation'; end if;
   decision := case when (payload->>'submit')::boolean is true then 'pending' else 'draft' end;
   if payload->>'id' is not null then
    select * into p from public.qh_posts where id=(payload->>'id')::uuid and author_id=actor and deleted_at is null for update;
    if p.id is null then raise exception using errcode='P0001',message='not_found'; end if;
    if p.status='published' and decision<>'published' then
     update public.qh_posts set pending_revision=jsonb_build_object('title',trim(payload->>'title'),'body',trim(payload->>'body'),'category',payload->>'category','preference',payload->>'preference'),revision_status=decision,reason='',updated_at=now() where id=p.id;
    else
     update public.qh_posts set title=trim(payload->>'title'),body=trim(payload->>'body'),category=payload->>'category',preference=payload->>'preference',status=decision,reason='',pending_revision=null,revision_status=null,updated_at=now() where id=p.id;
    end if;
    rid:=p.id;
   else
    insert into public.qh_posts(author_id,title,body,category,preference,status) values(actor,trim(payload->>'title'),trim(payload->>'body'),payload->>'category',payload->>'preference',decision) returning id into rid;
   end if;
   if decision='published' then insert into public.qh_audit(actor_id,action,target_id) values(actor,'posts.owner_publish',rid); end if;
 elsif action in ('posts.delete','posts.comments') then
   select * into p from public.qh_posts where id=(payload->>'id')::uuid and author_id=actor and deleted_at is null for update;
   if p.id is null then raise exception using errcode='P0001',message='not_found'; end if;
   if action='posts.delete' then update public.qh_posts set deleted_at=now(),pending_revision=null,revision_status=null where id=p.id;
   else update public.qh_posts set comments_open=(payload->>'open')::boolean where id=p.id; end if;
   rid:=p.id;
 elsif action='comments.save' then
   select * into p from public.qh_posts where id=(payload->>'post_id')::uuid and status='published' and deleted_at is null for update;
   if p.id is null or not p.comments_open or public.qh_blocked(actor,p.author_id) then raise exception using errcode='P0001',message='not_found'; end if;
   insert into public.qh_comments(post_id,author_id,body) values(p.id,actor,trim(payload->>'body')) returning id into rid;
 elsif action='comments.delete' then
   update public.qh_comments set deleted_at=now() where id=(payload->>'id')::uuid and author_id=actor and deleted_at is null returning id into rid;
   if rid is null then raise exception using errcode='P0001',message='not_found'; end if;
 elsif action='bookmarks.toggle' then
   select * into p from public.qh_posts where id=(payload->>'post_id')::uuid and status='published' and deleted_at is null;
   if p.id is null or public.qh_blocked(actor,p.author_id) then raise exception using errcode='P0001',message='not_found'; end if;
   delete from public.qh_bookmarks where user_id=actor and post_id=p.id;
   flag:=not found;
   if flag then insert into public.qh_bookmarks values(actor,p.id); end if;
   return jsonb_build_object('ok',true,'active',flag);
 elsif action='blocks.toggle' then
   rid:=(payload->>'user_id')::uuid;
   if rid=actor or not exists(select 1 from public.qh_profiles where id=rid) then raise exception using errcode='P0001',message='validation'; end if;
   delete from public.qh_blocks where user_id=actor and blocked_id=rid;
   flag:=not found;
   if flag then insert into public.qh_blocks values(actor,rid); end if;
   return jsonb_build_object('ok',true,'active',flag);
 elsif action='blocks.list' then
   return jsonb_build_object('users',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'nickname',x.nickname)) from public.qh_profiles x join public.qh_blocks b on b.blocked_id=x.id where b.user_id=actor),'[]'));
 elsif action='reports.create' then
   if payload->>'comment_id' is not null then
    select * into c from public.qh_comments where id=(payload->>'comment_id')::uuid and status='published' and deleted_at is null;
    if c.id is null then raise exception using errcode='P0001',message='not_found'; end if;
    pid:=c.post_id;
   else pid:=(payload->>'post_id')::uuid; end if;
   select * into p from public.qh_posts where id=pid and status='published' and deleted_at is null;
   if p.id is null then raise exception using errcode='P0001',message='not_found'; end if;
   insert into public.qh_reports(author_id,post_id,comment_id,reason) values(actor,p.id,c.id,trim(payload->>'reason')) returning id into rid;
 elsif action='appeals.create' then
   select * into p from public.qh_posts where id=(payload->>'post_id')::uuid and author_id=actor and deleted_at is null and (status in ('rejected','hidden') or revision_status='rejected');
   if p.id is null then raise exception using errcode='P0001',message='not_found'; end if;
   insert into public.qh_appeals(author_id,post_id,reason) values(actor,p.id,trim(payload->>'reason')) returning id into rid;
 elsif action='admin.queue' then
   return jsonb_build_object(
    'posts',coalesce((select jsonb_agg(value) from (select public.qh_post_json(x,true) value from public.qh_posts x where deleted_at is null and (status='pending' or revision_status='pending') order by updated_at limit 100) q),'[]'),
    'comments',coalesce((select jsonb_agg(value) from (select public.qh_comment_json(x) value from public.qh_comments x join public.qh_posts joined_post on joined_post.id=x.post_id where x.deleted_at is null and x.status='pending' and joined_post.deleted_at is null and joined_post.status='published' order by x.created_at limit 100) q),'[]'),
    'reports',coalesce((select jsonb_agg(value) from (select to_jsonb(x)||jsonb_build_object('nickname',pr.nickname,'target_title',joined_post.title,'target_body',coalesce(joined_comment.body,joined_post.body)) value from public.qh_reports x join public.qh_profiles pr on pr.id=x.author_id join public.qh_posts joined_post on joined_post.id=x.post_id left join public.qh_comments joined_comment on joined_comment.id=x.comment_id where x.status='open' order by x.created_at limit 100) q),'[]'),
    'appeals',coalesce((select jsonb_agg(value) from (select to_jsonb(x)||jsonb_build_object('nickname',pr.nickname,'target_title',joined_post.title) value from public.qh_appeals x join public.qh_profiles pr on pr.id=x.author_id join public.qh_posts joined_post on joined_post.id=x.post_id where x.status='open' order by x.created_at limit 100) q),'[]'));
 elsif action='admin.moderate' then
   rid:=(payload->>'id')::uuid; decision:=payload->>'decision'; why:=trim(payload->>'reason');
   if coalesce(char_length(why),0) not between 1 and 1000 then raise exception using errcode='P0001',message='validation'; end if;
   if payload->>'kind'='post' then
    select * into p from public.qh_posts where id=rid and deleted_at is null for update;
    if p.id is null or p.status='draft' then raise exception using errcode='P0001',message='not_found'; end if;
    if p.author_id=actor and u.role<>'owner' then raise exception using errcode='P0001',message='self_moderation'; end if;
    if decision='approve' then
     if p.revision_status in ('pending','rejected') then
      update public.qh_posts set title=pending_revision->>'title',body=pending_revision->>'body',category=pending_revision->>'category',preference=pending_revision->>'preference',pending_revision=null,revision_status=null,reason=why,updated_at=now() where id=rid;
     elsif p.status in ('pending','hidden','rejected') then update public.qh_posts set status='published',reason=why,updated_at=now() where id=rid;
     else raise exception using errcode='P0001',message='validation'; end if;
    elsif decision='reject' then
     if p.revision_status in ('pending','rejected') then update public.qh_posts set revision_status='rejected',reason=why,updated_at=now() where id=rid;
     elsif p.status='pending' then update public.qh_posts set status='rejected',reason=why,updated_at=now() where id=rid;
     else raise exception using errcode='P0001',message='validation'; end if;
    elsif decision='hide' then update public.qh_posts set status='hidden',pending_revision=null,revision_status=null,reason=why,updated_at=now() where id=rid;
    else raise exception using errcode='P0001',message='validation'; end if;
   elsif payload->>'kind'='comment' then
    select * into c from public.qh_comments where id=rid and deleted_at is null for update;
    if c.id is null then raise exception using errcode='P0001',message='not_found'; end if;
    if c.author_id=actor and u.role<>'owner' then raise exception using errcode='P0001',message='self_moderation'; end if;
    if decision not in ('approve','reject','hide') then raise exception using errcode='P0001',message='validation'; end if;
    update public.qh_comments set status=case decision when 'approve' then 'published' when 'reject' then 'rejected' else 'hidden' end,reason=why where id=rid;
   elsif payload->>'kind'='report' and decision='resolve' then
    update public.qh_reports set status='resolved',resolution=why where id=rid and status='open';
    if not found then raise exception using errcode='P0001',message='not_found'; end if;
   elsif payload->>'kind'='appeal' and decision in ('resolve','reject') then
    update public.qh_appeals set status=case when decision='resolve' then 'resolved' else 'rejected' end,resolution=why where id=rid and status='open';
    if not found then raise exception using errcode='P0001',message='not_found'; end if;
   else raise exception using errcode='P0001',message='validation'; end if;
   insert into public.qh_audit(actor_id,action,target_id,reason) values(actor,'moderate.'||(payload->>'kind')||'.'||decision,rid,why);
 elsif action='admin.users' then
   select coalesce(jsonb_agg(to_jsonb(x)-'bio'-'public_bio'),'[]') into items from (select * from public.qh_profiles order by created_at desc,id limit 21 offset offset_n) x;
   return jsonb_build_object('users',case when jsonb_array_length(items)>20 then items-20 else items end,'hasMore',jsonb_array_length(items)>20);
 elsif action='admin.user' then
   select * into target from public.qh_profiles where id=(payload->>'id')::uuid for update;
   if target.id is null then raise exception using errcode='P0001',message='not_found'; end if;
   if target.id=actor or target.role='owner' then raise exception using errcode='P0001',message='forbidden'; end if;
   if u.role='moderator' and (target.role<>'member' or target.status='banned' or payload ? 'role' or payload->>'status' not in ('active','muted')) then raise exception using errcode='P0001',message='forbidden'; end if;
   if payload ? 'role' and (u.role<>'owner' or payload->>'role' not in ('member','moderator')) then raise exception using errcode='P0001',message='forbidden'; end if;
   why:=trim(payload->>'reason');
   if coalesce(char_length(why),0) not between 1 and 1000 then raise exception using errcode='P0001',message='validation'; end if;
   update public.qh_profiles set role=coalesce(payload->>'role',role),status=coalesce(payload->>'status',status) where id=target.id;
   insert into public.qh_audit(actor_id,action,target_id,reason) values(actor,'user.'||coalesce(payload->>'role',target.role)||'.'||coalesce(payload->>'status',target.status),target.id,why);
 elsif action='admin.audit' then
   select coalesce(jsonb_agg(to_jsonb(x)),'[]') into items from (select * from public.qh_audit order by id desc limit 21 offset offset_n) x;
   return jsonb_build_object('events',case when jsonb_array_length(items)>20 then items-20 else items end,'hasMore',jsonb_array_length(items)>20);
 elsif action='admin.ai.get' then
   return jsonb_build_object('config',case when s.config='{}' then null else s.config end,'enabled',s.enabled,'user_daily_limit',s.user_daily_limit,'global_daily_limit',s.global_daily_limit,'key_set',s.encrypted_key is not null,'key_last4',s.key_last4);
 elsif action='admin.ai.save' then
   update public.qh_ai_settings set config=payload->'config',enabled=(payload->>'enabled')::boolean,
    encrypted_key=coalesce(payload->'encrypted_key',encrypted_key),key_last4=coalesce(payload->>'key_last4',key_last4),
    user_daily_limit=(payload->>'user_daily_limit')::integer,global_daily_limit=(payload->>'global_daily_limit')::integer,updated_at=now() where id=true;
   insert into public.qh_audit(actor_id,action,reason) values(actor,'ai.save','AI configuration updated');
 elsif action='admin.ai.test' then
   perform public.qh_rate(actor,'ai_test',5,3600);
   insert into public.qh_audit(actor_id,action,reason) values(actor,'ai.test','AI connection test');
 elsif action='admin.usage' then
   return jsonb_build_object('today',(now() at time zone 'UTC')::date,'total',coalesce((select sum(used) from public.qh_usage where day=(now() at time zone 'UTC')::date),0),
    'user_daily_limit',s.user_daily_limit,'global_daily_limit',s.global_daily_limit,
    'users',coalesce((select jsonb_agg(value) from (select jsonb_build_object('user_id',x.user_id,'nickname',joined_profile.nickname,'used',x.used) value from public.qh_usage x join public.qh_profiles joined_profile on joined_profile.id=x.user_id where day=(now() at time zone 'UTC')::date order by used desc limit 100) q),'[]'));
 else raise exception using errcode='P0001',message='validation'; end if;
 if action in ('posts.delete','comments.delete') then insert into public.qh_audit(actor_id,action,target_id) values(actor,action,rid); end if;
 return jsonb_build_object('ok',true,'id',rid);
end $$;
create or replace function public.qh_claim_moderation(actor uuid,job_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.qh_moderation_jobs;s public.qh_ai_settings;u public.qh_profiles;used_n integer;d date:=(now() at time zone 'UTC')::date;
begin
 select * into u from public.qh_profiles where id=actor for update;
 if u.id is null or u.status<>'active' or u.admission_status<>'approved' then raise exception 'forbidden';end if;
 select * into j from public.qh_moderation_jobs where id=job_id and author_id=actor for update;
 if j.id is null or j.status<>'queued' then raise exception 'not_found';end if;
 if not exists(select 1 from public.qh_posts where id=j.target_id and moderation_job_id=j.id and deleted_at is null and (status='pending' or revision_status='pending'))
 and not exists(select 1 from public.qh_comments where id=j.target_id and moderation_job_id=j.id and deleted_at is null and status='pending') then raise exception 'not_found';end if;
 select * into s from public.qh_ai_settings where id=true for update;
 if not s.enabled or s.encrypted_key is null or s.config='{}' then raise exception 'not_configured';end if;
 perform public.qh_reserve_model(actor,'moderation');
 update public.qh_moderation_jobs set status='running' where id=j.id;
 return jsonb_build_object('id',j.id,'kind',j.kind,'content',j.content,'context',j.context,'config',case when s.moderation_model<>'' then jsonb_set(s.config,'{model}',to_jsonb(s.moderation_model)) else s.config end,'encrypted_key',s.encrypted_key);
end $$;
create or replace function public.qh_complete_moderation(actor uuid,job_id uuid,decision text,reason text,rule_ids jsonb,policy_version text,model text) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.qh_moderation_jobs;p public.qh_posts;c public.qh_comments;newstatus text;
begin
 if decision not in ('approve','reject','review','error') or coalesce(char_length(reason),0)>1000 or jsonb_typeof(rule_ids)<>'array' or jsonb_array_length(rule_ids)>20 or char_length(policy_version)>100 or char_length(model)>200 then raise exception 'validation';end if;
 -- Serialize with all author mutations before checking the exact current job pointer.
 perform 1 from public.qh_profiles where id=actor for update;
 select * into j from public.qh_moderation_jobs where id=job_id and author_id=actor;
 if j.id is null then raise exception 'not_found';end if;
 if j.kind='post' then select * into p from public.qh_posts where id=j.target_id for update;
 else select * into c from public.qh_comments where id=j.target_id for update;end if;
 select * into j from public.qh_moderation_jobs where id=job_id for update;
 if j.status not in ('queued','running') or (j.status='queued' and decision<>'error') or
 (j.kind='post' and (p.moderation_job_id is distinct from j.id or p.deleted_at is not null or not(p.status='pending' or coalesce(p.revision_status='pending',false)))) or
 (j.kind='comment' and (c.moderation_job_id is distinct from j.id or c.deleted_at is not null or c.status<>'pending')) then
  return jsonb_build_object('ok',true,'applied',false,'status','superseded');
 end if;
 if not exists(select 1 from public.qh_profiles where id=actor and status='active' and admission_status='approved') then decision:='review';reason:='账户状态已变更，等待人工复核。';end if;
 if j.kind='comment' and not exists(select 1 from public.qh_posts where id=c.post_id and status='published' and deleted_at is null) then decision:='review';reason:='原帖状态已变更，等待人工复核。';end if;
 newstatus:=case decision when 'approve' then 'published' when 'reject' then 'rejected' else 'pending' end;
 if j.kind='post' then
  if p.pending_revision is not null then
   if decision='approve' then update public.qh_posts set title=pending_revision->>'title',body=pending_revision->>'body',category=pending_revision->>'category',preference=pending_revision->>'preference',pending_revision=null,revision_status=null,reason=qh_complete_moderation.reason,updated_at=now() where id=p.id;
   else update public.qh_posts set revision_status=newstatus,reason=qh_complete_moderation.reason,updated_at=now() where id=p.id;end if;
  else update public.qh_posts set status=newstatus,reason=qh_complete_moderation.reason,updated_at=now() where id=p.id;end if;
 else update public.qh_comments set status=newstatus,reason=qh_complete_moderation.reason where id=c.id;end if;
 update public.qh_moderation_jobs set status=decision,reason=qh_complete_moderation.reason,rule_ids=qh_complete_moderation.rule_ids,policy_version=qh_complete_moderation.policy_version,model=qh_complete_moderation.model,completed_at=now() where id=j.id;
 insert into public.qh_audit(actor_id,action,target_id,reason) values(null,'moderation.ai.'||decision,j.target_id,left(policy_version||' / '||model||' / '||rule_ids::text,1000));
 return jsonb_build_object('ok',true,'applied',true,'status',newstatus,'reason',reason);
end $$;

alter function public.qh_action(uuid,text,jsonb,boolean) rename to qh_action_before_audit;
revoke all on function public.qh_action_before_audit(uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;
create function public.qh_action(actor uuid,action text,payload jsonb default '{}',aal2 boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qh_profiles;t public.qh_profiles;r jsonb;rid uuid;today date:=(now() at time zone 'UTC')::date;begin
 select * into u from public.qh_profiles where id=actor for update;
 if u.id is null then raise exception 'unauthorized';end if;
 if action like 'admin.%' then
  if u.admission_status<>'approved' then raise exception 'admission_required';end if;
  if u.role not in ('owner','moderator') or u.status<>'active' then raise exception 'forbidden';end if;
  if action in ('admin.ai.get','admin.ai.save','admin.ai.test','admin.usage','admin.audit','admin.purge','admin.invites.list','admin.invites.create','admin.invites.update') and u.role<>'owner' then raise exception 'forbidden';end if;
  if aal2 is not true then raise exception 'mfa_required';end if;
 end if;
 perform public.qh_cleanup();
 if action='admin.purge' then
  rid:=(payload->>'id')::uuid;
  if coalesce(char_length(trim(payload->>'reason')),0) not between 1 and 1000 then raise exception 'validation';end if;
  select * into t from public.qh_profiles where id=rid for update;
  if t.id is null then raise exception 'not_found';end if;
  if rid=actor or t.role='owner' then raise exception 'forbidden';end if;
  delete from auth.users where id=rid;
  insert into public.qh_audit(actor_id,action,reason) values(actor,'admin.purge','Account and associated content erased');
  return jsonb_build_object('ok',true);
 elsif action in ('posts.delete','comments.delete') then
  if u.status='banned' or u.admission_status<>'approved' then raise exception 'forbidden';end if;
  rid:=(payload->>'id')::uuid;
  if action='posts.delete' then delete from public.qh_posts where id=rid and author_id=actor;
  else delete from public.qh_comments where id=rid and author_id=actor;end if;
  if not found then raise exception 'not_found';end if;
  insert into public.qh_audit(actor_id,action,target_id) values(actor,action,rid);
  return jsonb_build_object('ok',true,'id',rid);
 elsif action='admin.invites.create' then
  payload:=payload||jsonb_build_object('expires_at',coalesce((payload->>'expires_at')::timestamptz,now()+interval '30 days'));
  if (payload->>'expires_at')::timestamptz>now()+interval '90 days' then raise exception 'validation';end if;
 end if;
 r:=public.qh_action_before_audit(actor,action,payload,aal2);
 if action='admin.invites.update' and payload ? 'expires_at' then
  if (payload->>'expires_at')::timestamptz is null or (payload->>'expires_at')::timestamptz<=now() or (payload->>'expires_at')::timestamptz>now()+interval '90 days' then raise exception 'validation';end if;
  update public.qh_invites set expires_at=(payload->>'expires_at')::timestamptz where id=(payload->>'id')::uuid;
 elsif action='admin.usage' then
  r:=r||jsonb_build_object('total',coalesce((select used from public.qh_global_usage where day=today),0),
   'provider_calls',coalesce((select sum(provider_calls) from public.qh_usage where day=today),0),
   'chat_turns',coalesce((select sum(chat_turns) from public.qh_usage where day=today),0),
   'moderation_used',coalesce((select sum(moderation_used) from public.qh_usage where day=today),0));
 end if;
 return r;
end $$;
-- Give every old invite a bounded lifetime too.
update public.qh_invites set expires_at=now()+interval '30 days' where expires_at is null;
do $$ declare t text;begin
 for t in select tablename from pg_tables where schemaname='public' and tablename like 'qh_%' loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
revoke all on function public.qh_erase_content(),public.qh_erase_account_attribution(),public.qh_rate(uuid,text,integer,integer),public.qh_cleanup(),public.qh_reserve_model(uuid,text),public.qh_record_ai_call(uuid,text,boolean),public.qh_action(uuid,text,jsonb,boolean),public.qh_claim_moderation(uuid,uuid),public.qh_complete_moderation(uuid,uuid,text,text,jsonb,text,text),public.qh_reserve_ai(uuid) from public,anon,authenticated;
grant execute on function public.qh_cleanup(),public.qh_reserve_model(uuid,text),public.qh_record_ai_call(uuid,text,boolean),public.qh_action(uuid,text,jsonb,boolean),public.qh_claim_moderation(uuid,uuid),public.qh_complete_moderation(uuid,uuid,text,text,jsonb,text,text),public.qh_reserve_ai(uuid) to service_role;
revoke all on function public.qh_erase_content(),public.qh_erase_account_attribution() from service_role;
do $$ begin
 if exists(select 1 from pg_extension where extname='pg_cron') then
  execute $cron$select cron.schedule('quiet-harbor-retention','17 2 * * *','select public.qh_cleanup()')$cron$;
 end if;
end $$;
create function public.qh_backend_version() returns jsonb language sql stable security definer set search_path='' as $$ select '{"schema":"202610030004"}'::jsonb $$;
revoke all on function public.qh_backend_version() from public,anon,authenticated;
grant execute on function public.qh_backend_version() to service_role;
select public.qh_cleanup();
commit;
