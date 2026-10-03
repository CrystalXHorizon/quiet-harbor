begin;
alter table public.qh_profiles add column avatar text not null default 'harbor' check(avatar in ('harbor','leaf','moon','sun','wave','star'));
alter table public.qh_profiles add column bio text not null default '' check(char_length(bio)<=200);
alter table public.qh_profiles add column public_bio boolean not null default false;
alter table public.qh_appeals add column resolved_at timestamptz;
alter table public.qh_appeals add column resolution_decision text check(resolution_decision in ('restore','reject','resolve'));
create table public.qh_notifications(
 id uuid primary key default gen_random_uuid(),user_id uuid not null,
 kind text not null,title text not null,body text not null default '',post_id uuid,comment_id uuid,
 read_at timestamptz,created_at timestamptz not null default now()
);
create index qh_notifications_user on public.qh_notifications(user_id,created_at desc,id);
alter table public.qh_notifications enable row level security;
revoke all on public.qh_notifications from public,anon,authenticated;
grant all on public.qh_notifications to service_role;
create function public.qh_notify_changes() returns trigger language plpgsql security definer set search_path='' as $$
declare recipient uuid;parent public.qh_posts;state text;
begin
 if tg_table_name='qh_profiles' and tg_op='DELETE' then
  delete from public.qh_notifications where user_id=old.id;return old;
 end if;
 if tg_table_name='qh_posts' then
  if new.deleted_at is not null then return new;end if;
  if (old.status is distinct from new.status and new.status in ('published','rejected','hidden')) or
   (old.revision_status is distinct from new.revision_status and (new.revision_status='rejected' or (old.revision_status in ('pending','rejected') and new.revision_status is null and new.status='published'))) then
   state:=case when new.revision_status='rejected' then 'rejected' else new.status end;
   insert into public.qh_notifications(user_id,kind,title,body,post_id) values(new.author_id,'post_review','帖子审核结果',case state when 'published' then '你的帖子已发布。' when 'rejected' then '你的帖子未通过审核。' else '你的帖子已被隐藏。' end||case when new.reason<>'' then ' 原因：'||left(new.reason,1000) else '' end,new.id);
  end if;
 elsif tg_table_name='qh_comments' then
  if new.deleted_at is not null then return new;end if;
  if old.status is distinct from new.status and new.status in ('published','rejected','hidden') then
   insert into public.qh_notifications(user_id,kind,title,body,post_id,comment_id) values(new.author_id,'comment_review','回复审核结果',case new.status when 'published' then '你的回复已发布。' when 'rejected' then '你的回复未通过审核。' else '你的回复已被隐藏。' end||case when new.reason<>'' then ' 原因：'||left(new.reason,1000) else '' end,new.post_id,new.id);
   if new.status='published' and old.status='pending' then
    select * into parent from public.qh_posts where id=new.post_id and status='published' and deleted_at is null;
    if parent.id is not null and parent.author_id<>new.author_id and not public.qh_blocked(parent.author_id,new.author_id) then
     insert into public.qh_notifications(user_id,kind,title,body,post_id,comment_id) values(parent.author_id,'received_reply','你收到了新回复','有人回复了你的帖子，点击查看。',new.post_id,new.id);
    end if;
   end if;
  end if;
 elsif tg_table_name='qh_appeals' then
  if old.status is distinct from new.status and new.status in ('resolved','rejected') then
   insert into public.qh_notifications(user_id,kind,title,body,post_id,comment_id) values(new.author_id,'appeal_result','申诉处理结果',case when new.status='resolved' then '你的申诉已处理。' else '你的申诉未获支持。' end||' '||left(new.resolution,1000),new.post_id,new.comment_id);
  end if;
 elsif tg_table_name='qh_profiles' then
  if old.status is distinct from new.status or old.role is distinct from new.role or old.admission_status is distinct from new.admission_status then
   insert into public.qh_notifications(user_id,kind,title,body) values(new.id,'account_update','账户状态已更新','你的账户权限或使用状态已更新，请查看账户信息。如有异议，请联系站点管理员。');
  end if;
 end if;
 return new;
end $$;
revoke all on function public.qh_notify_changes() from public,anon,authenticated,service_role;
create trigger qh_post_notifications after update on public.qh_posts for each row execute function public.qh_notify_changes();
create trigger qh_comment_notifications after update on public.qh_comments for each row execute function public.qh_notify_changes();
create trigger qh_appeal_notifications after update on public.qh_appeals for each row execute function public.qh_notify_changes();
-- Recipient deletion is explicit to avoid profile-FK locks during cross-user review notifications.
create trigger qh_account_notification_cleanup after delete on public.qh_profiles for each row execute function public.qh_notify_changes();
create trigger qh_account_notifications after update on public.qh_profiles for each row execute function public.qh_notify_changes();
alter function public.qh_action(uuid,text,jsonb,boolean) rename to qh_action_before_personal;
revoke all on function public.qh_action_before_personal(uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;
create function public.qh_action(actor uuid,action text,payload jsonb default '{}',aal2 boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qh_profiles;t public.qh_profiles;r jsonb;items jsonb;n integer;offset_n integer:=greatest(0,least(coalesce((payload->>'page')::integer,0),1000))*20;
begin
 if action like 'personal.%' or action like 'notifications.%' or action in ('profiles.get','profile.update','bookmarks.remove') then
  select * into u from public.qh_profiles where id=actor for update;
  if u.id is null then raise exception 'unauthorized';end if;
  if u.status='banned' then raise exception 'forbidden';end if;
  if u.admission_status<>'approved' then raise exception 'admission_required';end if;
  perform public.qh_rate(actor,'api',120,60);
  if action='profile.update' then
   if not(payload ?| array['nickname','avatar','bio','public_bio']) then raise exception 'validation';end if;
   if (payload ? 'nickname' and (jsonb_typeof(payload->'nickname')<>'string' or char_length(trim(payload->>'nickname')) not between 1 and 40)) or
    (payload ? 'avatar' and (jsonb_typeof(payload->'avatar')<>'string' or payload->>'avatar' not in ('harbor','leaf','moon','sun','wave','star'))) or
    (payload ? 'bio' and (jsonb_typeof(payload->'bio')<>'string' or char_length(payload->>'bio')>200)) or
    (payload ? 'public_bio' and jsonb_typeof(payload->'public_bio')<>'boolean') then raise exception 'validation';end if;
   update public.qh_profiles set nickname=coalesce(trim(payload->>'nickname'),nickname),avatar=coalesce(payload->>'avatar',avatar),bio=coalesce(payload->>'bio',bio),public_bio=coalesce((payload->>'public_bio')::boolean,public_bio) where id=actor;
   return jsonb_build_object('ok',true);
  elsif action='bookmarks.remove' then
   delete from public.qh_bookmarks where user_id=actor and post_id=(payload->>'post_id')::uuid;
   return jsonb_build_object('ok',true);
  elsif action='profiles.get' then
   select * into t from public.qh_profiles where id=(payload->>'user_id')::uuid and admission_status='approved' and status<>'banned';
   if t.id is null or public.qh_blocked(actor,t.id) then raise exception 'not_found';end if;
   return jsonb_build_object('profile',jsonb_build_object('id',t.id,'nickname',t.nickname,'avatar',t.avatar,'created_at',t.created_at,'bio',case when t.public_bio then t.bio else '' end));
  elsif action='personal.overview' then
   return jsonb_build_object('counts',jsonb_build_object('posts',(select count(*) from public.qh_posts where author_id=actor and deleted_at is null),'comments',(select count(*) from public.qh_comments where author_id=actor and deleted_at is null),'bookmarks',(select count(*) from public.qh_bookmarks where user_id=actor),'appeals',(select count(*) from public.qh_appeals where author_id=actor),'unread',(select count(*) from public.qh_notifications where user_id=actor and read_at is null)));
  elsif action='personal.comments' then
   select coalesce(jsonb_agg(v),'[]') into items from (select public.qh_comment_json(c)||jsonb_build_object('post_title',case when p.deleted_at is null and p.status='published' and not public.qh_blocked(actor,p.author_id) then p.title else '原帖暂不可见' end,'available',p.deleted_at is null and p.status='published' and not public.qh_blocked(actor,p.author_id)) v from public.qh_comments c join public.qh_posts p on p.id=c.post_id where c.author_id=actor and c.deleted_at is null order by c.created_at desc,c.id limit 21 offset offset_n) q;
   return jsonb_build_object('comments',case when jsonb_array_length(items)>20 then items-20 else items end,'hasMore',jsonb_array_length(items)>20);
  elsif action='personal.appeals' then
   select coalesce(jsonb_agg(v),'[]') into items from (select jsonb_build_object('id',a.id,'post_id',a.post_id,'comment_id',a.comment_id,'reason',a.reason,'status',a.status,'resolution',a.resolution,'resolution_decision',a.resolution_decision,'resolved_at',a.resolved_at,'created_at',a.created_at,'available',exists(select 1 from public.qh_posts ap where ap.id=a.post_id and ap.deleted_at is null and (ap.author_id=actor or (ap.status='published' and not public.qh_blocked(actor,ap.author_id)))),'content',jsonb_build_object('title',case when a.comment_id is null then a.content_snapshot->>'title' else '回复申诉' end,'body',a.content_snapshot->>'body')) v from public.qh_appeals a where a.author_id=actor order by a.created_at desc,a.id limit 21 offset offset_n) q;
   return jsonb_build_object('appeals',case when jsonb_array_length(items)>20 then items-20 else items end,'hasMore',jsonb_array_length(items)>20);
  elsif action='personal.bookmarks' then
   select coalesce(jsonb_agg(v),'[]') into items from (select case when p.deleted_at is null and p.status='published' and not public.qh_blocked(actor,p.author_id) then public.qh_post_json(p,false)||'{"available":true}'::jsonb else jsonb_build_object('id',p.id,'title','收藏内容暂不可见','available',false) end v from public.qh_bookmarks b join public.qh_posts p on p.id=b.post_id where b.user_id=actor order by b.post_id limit 21 offset offset_n) q;
   return jsonb_build_object('bookmarks',case when jsonb_array_length(items)>20 then items-20 else items end,'hasMore',jsonb_array_length(items)>20);
  elsif action='notifications.list' then
   select coalesce(jsonb_agg(v),'[]') into items from (select to_jsonb(x)-'user_id' v from public.qh_notifications x where user_id=actor order by created_at desc,id limit 21 offset offset_n) q;
   return jsonb_build_object('notifications',case when jsonb_array_length(items)>20 then items-20 else items end,'hasMore',jsonb_array_length(items)>20,'unread',(select count(*) from public.qh_notifications where user_id=actor and read_at is null));
  elsif action='notifications.read' then
   update public.qh_notifications set read_at=coalesce(read_at,now()) where id=(payload->>'id')::uuid and user_id=actor;
   if not found then raise exception 'not_found';end if;
   return jsonb_build_object('ok',true);
  elsif action='notifications.read_all' then
   update public.qh_notifications set read_at=now() where user_id=actor and read_at is null;
   return jsonb_build_object('ok',true);
  else raise exception 'validation';end if;
 end if;
 r:=public.qh_action_before_personal(actor,action,payload,aal2);
 if action='admin.moderate' and payload->>'kind'='appeal' and payload->>'decision' in ('restore','reject','resolve') then
  update public.qh_appeals set resolved_at=now(),resolution_decision=payload->>'decision' where id=(payload->>'id')::uuid;
 end if;
 return r;
end $$;
revoke all on function public.qh_action(uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.qh_action(uuid,text,jsonb,boolean) to service_role;
commit;
