-- All application data is accessed through the authenticated Edge Function.
-- No browser role can read tables or execute these actor-scoped service RPCs.
create table public.qh_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 40),
  role text not null default 'member' check (role in ('member','moderator','owner')),
  status text not null default 'active' check (status in ('active','muted','banned')),
  created_at timestamptz not null default now()
);
create unique index qh_one_owner on public.qh_profiles(role) where role = 'owner';
create function public.qh_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 insert into public.qh_profiles(id,nickname) values(new.id,coalesce(nullif(left(trim(new.raw_user_meta_data->>'nickname'),40),''),'留岸访客')) on conflict do nothing;
 return new;
end $$;
create trigger qh_auth_user_created after insert on auth.users for each row execute function public.qh_new_user();
insert into public.qh_profiles(id,nickname) select id,coalesce(nullif(left(trim(raw_user_meta_data->>'nickname'),40),''),'留岸访客') from auth.users on conflict do nothing;

create table public.qh_posts (
 id uuid primary key default gen_random_uuid(), author_id uuid not null references public.qh_profiles(id),
 title text not null check(char_length(title) between 1 and 120), body text not null check(char_length(body) between 1 and 6000),
 category text not null check(category in ('share','advice','progress')),
 preference text not null check(preference in ('listen','advice')),
 status text not null default 'draft' check(status in ('draft','pending','published','rejected','hidden')),
 pending_revision jsonb, revision_status text check(revision_status in ('draft','pending','rejected')),
 reason text not null default '', comments_open boolean not null default true,
 deleted_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check ((pending_revision is null) = (revision_status is null))
);
create index qh_feed on public.qh_posts(created_at desc) where deleted_at is null and status='published';
create index qh_my_posts on public.qh_posts(author_id,created_at desc);
create table public.qh_comments (
 id uuid primary key default gen_random_uuid(), post_id uuid not null references public.qh_posts(id),
 author_id uuid not null references public.qh_profiles(id), body text not null check(char_length(body) between 1 and 3000),
 status text not null default 'pending' check(status in ('pending','published','rejected','hidden')),
 reason text not null default '', deleted_at timestamptz, created_at timestamptz not null default now()
);
create index qh_post_comments on public.qh_comments(post_id,created_at);
create table public.qh_bookmarks (user_id uuid references public.qh_profiles(id) on delete cascade, post_id uuid references public.qh_posts(id) on delete cascade, primary key(user_id,post_id));
create table public.qh_blocks (user_id uuid references public.qh_profiles(id) on delete cascade, blocked_id uuid references public.qh_profiles(id) on delete cascade, primary key(user_id,blocked_id), check(user_id<>blocked_id));
create table public.qh_reports (
 id uuid primary key default gen_random_uuid(), author_id uuid not null references public.qh_profiles(id),
 post_id uuid not null references public.qh_posts(id), comment_id uuid references public.qh_comments(id),
 reason text not null check(char_length(reason) between 1 and 1000),
 status text not null default 'open' check(status in ('open','resolved')),
 resolution text not null default '', created_at timestamptz not null default now()
);
create unique index qh_report_post_once on public.qh_reports(author_id,post_id) where status='open' and comment_id is null;
create unique index qh_report_comment_once on public.qh_reports(author_id,comment_id) where status='open' and comment_id is not null;
create table public.qh_appeals (
 id uuid primary key default gen_random_uuid(), author_id uuid not null references public.qh_profiles(id), post_id uuid not null references public.qh_posts(id),
 reason text not null check(char_length(reason) between 1 and 1000), status text not null default 'open' check(status in ('open','resolved','rejected')),
 resolution text not null default '', created_at timestamptz not null default now()
);
create unique index qh_one_open_appeal on public.qh_appeals(author_id,post_id) where status='open';
create table public.qh_audit (
 id bigint generated always as identity primary key, actor_id uuid, action text not null, target_id uuid,
 reason text not null default '', created_at timestamptz not null default now()
);
create table public.qh_ai_settings (
 id boolean primary key default true check(id), config jsonb not null default '{}', encrypted_key jsonb, key_last4 text not null default '',
 enabled boolean not null default false, user_daily_limit integer not null default 30 check(user_daily_limit between 1 and 1000),
 global_daily_limit integer not null default 300 check(global_daily_limit between 1 and 100000), updated_at timestamptz not null default now()
);
insert into public.qh_ai_settings(id) values(true);
create table public.qh_usage (
 day date not null, user_id uuid not null references public.qh_profiles(id), used integer not null default 0,
 primary key(day,user_id)
);
create table public.qh_rate_limits (
 user_id uuid not null references public.qh_profiles(id) on delete cascade, bucket text not null,
 window_start timestamptz not null, used integer not null default 0, primary key(user_id,bucket)
);

create function public.qh_blocked(a uuid,b uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.qh_blocks where (user_id=a and blocked_id=b) or (user_id=b and blocked_id=a))
$$;
create function public.qh_post_json(p public.qh_posts, proposed boolean default false) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'author_id',p.author_id,'nickname',(select nickname from public.qh_profiles where id=p.author_id),
 'title',case when proposed and p.pending_revision is not null then p.pending_revision->>'title' else p.title end,
 'body',case when proposed and p.pending_revision is not null then p.pending_revision->>'body' else p.body end,
 'category',case when proposed and p.pending_revision is not null then p.pending_revision->>'category' else p.category end,
 'preference',case when proposed and p.pending_revision is not null then p.pending_revision->>'preference' else p.preference end,
 'status',case when proposed and p.pending_revision is not null then p.revision_status else p.status end,
 'live_status',p.status,'has_revision',p.pending_revision is not null,'reason',case when proposed then p.reason else '' end,
 'comments_open',p.comments_open,'created_at',p.created_at,'updated_at',p.updated_at)
$$;
create function public.qh_comment_json(c public.qh_comments) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',c.id,'post_id',c.post_id,'author_id',c.author_id,'nickname',(select nickname from public.qh_profiles where id=c.author_id),'body',c.body,'status',c.status,'reason',c.reason,'created_at',c.created_at)
$$;

create function public.qh_rate(actor uuid,b text,capacity integer,seconds integer) returns void language plpgsql set search_path='' as $$
declare r public.qh_rate_limits;
begin
 insert into public.qh_rate_limits(user_id,bucket,window_start) values(actor,b,now()) on conflict do nothing;
 select * into r from public.qh_rate_limits where user_id=actor and bucket=b for update;
 if r.window_start + make_interval(secs=>seconds) <= now() then
   update public.qh_rate_limits set window_start=now(),used=1 where user_id=actor and bucket=b;
 elsif r.used >= capacity then raise exception using errcode='P0001',message='rate_limit';
 else update public.qh_rate_limits set used=used+1 where user_id=actor and bucket=b; end if;
end $$;

-- Reserves quota BEFORE any paid upstream call. One reservation covers a harness turn
-- (up to three model calls). Failed/aborted attempts still consume quota.
create function public.qh_reserve_ai(actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qh_profiles; settings public.qh_ai_settings; n integer; total bigint; today date := (now() at time zone 'UTC')::date;
begin
 select * into u from public.qh_profiles where id=actor for share;
 if u.id is null or u.status='banned' then raise exception using errcode='P0001',message='forbidden'; end if;
 select * into settings from public.qh_ai_settings where id=true for update;
 if not settings.enabled or settings.encrypted_key is null then raise exception using errcode='P0001',message='not_configured'; end if;
 perform public.qh_rate(actor,'chat',5,60);
 select coalesce(sum(used),0) into total from public.qh_usage where day=today;
 select used into n from public.qh_usage where day=today and user_id=actor;
 if coalesce(n,0)>=settings.user_daily_limit or total>=settings.global_daily_limit then raise exception using errcode='P0001',message='quota_exceeded'; end if;
 insert into public.qh_usage(day,user_id,used) values(today,actor,1) on conflict(day,user_id) do update set used=public.qh_usage.used+1;
 return jsonb_build_object('config',settings.config,'encrypted_key',settings.encrypted_key);
end $$;

create function public.qh_action(actor uuid, action text, payload jsonb default '{}', aal2 boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
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
   if not aal2 then raise exception using errcode='P0001',message='mfa_required'; end if;
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
    if p.status='published' then
     update public.qh_posts set pending_revision=jsonb_build_object('title',trim(payload->>'title'),'body',trim(payload->>'body'),'category',payload->>'category','preference',payload->>'preference'),revision_status=decision,reason='',updated_at=now() where id=p.id;
    else
     update public.qh_posts set title=trim(payload->>'title'),body=trim(payload->>'body'),category=payload->>'category',preference=payload->>'preference',status=decision,reason='',pending_revision=null,revision_status=null,updated_at=now() where id=p.id;
    end if;
    rid:=p.id;
   else
    insert into public.qh_posts(author_id,title,body,category,preference,status) values(actor,trim(payload->>'title'),trim(payload->>'body'),payload->>'category',payload->>'preference',decision) returning id into rid;
   end if;
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
    'comments',coalesce((select jsonb_agg(value) from (select public.qh_comment_json(x) value from public.qh_comments x join public.qh_posts p on p.id=x.post_id where x.deleted_at is null and x.status='pending' and p.deleted_at is null and p.status='published' order by x.created_at limit 100) q),'[]'),
    'reports',coalesce((select jsonb_agg(value) from (select to_jsonb(x)||jsonb_build_object('nickname',pr.nickname,'target_title',p.title,'target_body',coalesce(c.body,p.body)) value from public.qh_reports x join public.qh_profiles pr on pr.id=x.author_id join public.qh_posts p on p.id=x.post_id left join public.qh_comments c on c.id=x.comment_id where x.status='open' order by x.created_at limit 100) q),'[]'),
    'appeals',coalesce((select jsonb_agg(value) from (select to_jsonb(x)||jsonb_build_object('nickname',pr.nickname,'target_title',p.title) value from public.qh_appeals x join public.qh_profiles pr on pr.id=x.author_id join public.qh_posts p on p.id=x.post_id where x.status='open' order by x.created_at limit 100) q),'[]'));
 elsif action='admin.moderate' then
   rid:=(payload->>'id')::uuid; decision:=payload->>'decision'; why:=trim(payload->>'reason');
   if coalesce(char_length(why),0) not between 1 and 1000 then raise exception using errcode='P0001',message='validation'; end if;
   if payload->>'kind'='post' then
    select * into p from public.qh_posts where id=rid and deleted_at is null for update;
    if p.id is null or p.status='draft' then raise exception using errcode='P0001',message='not_found'; end if;
    if p.author_id=actor then raise exception using errcode='P0001',message='self_moderation'; end if;
    if decision='approve' then
     if p.revision_status='pending' then
      update public.qh_posts set title=pending_revision->>'title',body=pending_revision->>'body',category=pending_revision->>'category',preference=pending_revision->>'preference',pending_revision=null,revision_status=null,reason=why,updated_at=now() where id=rid;
     elsif p.status in ('pending','hidden','rejected') then update public.qh_posts set status='published',reason=why,updated_at=now() where id=rid;
     else raise exception using errcode='P0001',message='validation'; end if;
    elsif decision='reject' then
     if p.revision_status='pending' then update public.qh_posts set revision_status='rejected',reason=why,updated_at=now() where id=rid;
     elsif p.status='pending' then update public.qh_posts set status='rejected',reason=why,updated_at=now() where id=rid;
     else raise exception using errcode='P0001',message='validation'; end if;
    elsif decision='hide' then update public.qh_posts set status='hidden',pending_revision=null,revision_status=null,reason=why,updated_at=now() where id=rid;
    else raise exception using errcode='P0001',message='validation'; end if;
   elsif payload->>'kind'='comment' then
    select * into c from public.qh_comments where id=rid and deleted_at is null for update;
    if c.id is null then raise exception using errcode='P0001',message='not_found'; end if;
    if c.author_id=actor then raise exception using errcode='P0001',message='self_moderation'; end if;
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
   return jsonb_build_object('users',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from public.qh_profiles order by created_at desc limit 100 offset offset_n) x),'[]'));
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
   return jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from public.qh_audit order by id desc limit 100 offset offset_n) x),'[]'));
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
    'users',coalesce((select jsonb_agg(value) from (select jsonb_build_object('user_id',x.user_id,'nickname',p.nickname,'used',x.used) value from public.qh_usage x join public.qh_profiles p on p.id=x.user_id where day=(now() at time zone 'UTC')::date order by used desc limit 100) q),'[]'));
 else raise exception using errcode='P0001',message='validation'; end if;
 if action in ('posts.delete','comments.delete') then insert into public.qh_audit(actor_id,action,target_id) values(actor,action,rid); end if;
 return jsonb_build_object('ok',true,'id',rid);
end $$;

-- Authenticated browsers have no grants, even if a permissive RLS policy is added later.
do $$ declare t text; f record; begin
 for t in select tablename from pg_tables where schemaname='public' and tablename like 'qh_%' loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on table public.%I from public, anon, authenticated',t);
  execute format('grant all on table public.%I to service_role',t);
 end loop;
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'qh_%' loop
  execute format('revoke all on function %s from public, anon, authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
revoke all on sequence public.qh_audit_id_seq from public, anon, authenticated;
grant all on sequence public.qh_audit_id_seq to service_role;
