begin;
-- Existing accounts retain access; every subsequently created Auth account starts pending.
alter table public.qh_profiles add column admission_status text not null default 'approved' check(admission_status in ('pending','approved','rejected'));
alter table public.qh_profiles alter column admission_status set default 'pending';
create table public.qh_applications (
 user_id uuid primary key references public.qh_profiles(id) on delete cascade,
 reason text not null check(char_length(reason) between 1 and 1000),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 review_reason text not null default '', reviewed_by uuid references public.qh_profiles(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.qh_invites (
 id uuid primary key default gen_random_uuid(), code_hash text not null unique check(code_hash ~ '^[a-f0-9]{64}$'),
 code_hint text not null check(char_length(code_hint)=4), label text not null check(char_length(label) between 1 and 80),
 max_uses integer not null check(max_uses between 1 and 10000), used integer not null default 0 check(used>=0 and used<=max_uses),
 expires_at timestamptz, enabled boolean not null default true,
 created_by uuid not null references public.qh_profiles(id), created_at timestamptz not null default now()
);
create table public.qh_invite_redemptions (
 user_id uuid primary key references public.qh_profiles(id), invite_id uuid not null references public.qh_invites(id), created_at timestamptz not null default now()
);
alter function public.qh_action(uuid,text,jsonb,boolean) rename to qh_action_admitted;
alter function public.qh_reserve_ai(uuid) rename to qh_reserve_ai_admitted;
-- Legacy implementations are private implementation details, not externally callable RPCs.
revoke all on function public.qh_action_admitted(uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function public.qh_reserve_ai_admitted(uuid) from public,anon,authenticated,service_role;
create function public.qh_reserve_ai(actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qh_profiles;
begin
 select * into u from public.qh_profiles where id=actor for share;
 if u.id is null or u.status='banned' then raise exception 'forbidden'; end if;
 if u.admission_status<>'approved' then raise exception 'admission_required'; end if;
 return public.qh_reserve_ai_admitted(actor);
end $$;
create function public.qh_action(actor uuid,action text,payload jsonb default '{}',aal2 boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qh_profiles; target public.qh_profiles; inv public.qh_invites; result jsonb; items jsonb; rid uuid; why text; decision text;
 offset_n integer := greatest(0,least(coalesce((payload->>'page')::integer,0),1000))*20;
begin
 select * into u from public.qh_profiles where id=actor for update;
 if u.id is null then raise exception 'unauthorized'; end if;
 if action='me' then
  result:=public.qh_action_admitted(actor,action,payload,aal2);
  if u.admission_status<>'approved' then result:=jsonb_set(result,'{ai,ready}','false'); end if;
  return result||jsonb_build_object('application',(select to_jsonb(a)-'reviewed_by' from public.qh_applications a where user_id=actor));
 end if;
 if u.status='banned' then raise exception 'forbidden'; end if;
 if action in ('admission.apply','admission.redeem') then
  perform public.qh_rate(actor,'admission',10,3600);
  if u.admission_status='approved' then return jsonb_build_object('ok',true,'status','approved'); end if;
  if action='admission.apply' then
   why:=trim(payload->>'reason');
   if coalesce(char_length(why),0) not between 1 and 1000 then raise exception 'validation'; end if;
   insert into public.qh_applications(user_id,reason) values(actor,why)
    on conflict(user_id) do update set reason=excluded.reason,status='pending',review_reason='',reviewed_by=null,updated_at=now();
   update public.qh_profiles set admission_status='pending' where id=actor;
   insert into public.qh_audit(actor_id,action,target_id) values(actor,'admission.apply',actor);
   return jsonb_build_object('ok',true,'status','pending');
  end if;
  select * into inv from public.qh_invites where code_hash=payload->>'code_hash' for update;
  if inv.id is null or not inv.enabled or inv.used>=inv.max_uses or inv.expires_at<=now() then return jsonb_build_object('error_code','invite_invalid'); end if;
  update public.qh_invites set used=used+1 where id=inv.id;
  insert into public.qh_invite_redemptions(user_id,invite_id) values(actor,inv.id);
  update public.qh_profiles set admission_status='approved' where id=actor;
  update public.qh_applications set status='approved',review_reason='通过邀请码加入',updated_at=now() where user_id=actor;
  insert into public.qh_audit(actor_id,action,target_id) values(actor,'admission.invite',inv.id);
  return jsonb_build_object('ok',true,'status','approved');
 end if;
 if u.admission_status<>'approved' then raise exception 'admission_required'; end if;
 if action in ('admin.applications','admin.application.review','admin.invites.list','admin.invites.create','admin.invites.update') then
  perform public.qh_rate(actor,'api',120,60);
  if u.role not in ('owner','moderator') or u.status<>'active' then raise exception 'forbidden'; end if;
  if action like 'admin.invites.%' and u.role<>'owner' then raise exception 'forbidden'; end if;
  if action in ('admin.application.review','admin.invites.create','admin.invites.update') and not aal2 then raise exception 'mfa_required'; end if;
  if action='admin.applications' then
   select coalesce(jsonb_agg(value),'[]') into items from (
    select to_jsonb(a)-'user_id'||jsonb_build_object('id',a.user_id,'nickname',p.nickname) value
    from public.qh_applications a join public.qh_profiles p on p.id=a.user_id
    order by (a.status='pending') desc,a.created_at,a.user_id limit 21 offset offset_n
   ) q;
   return jsonb_build_object('items',case when jsonb_array_length(items)>20 then items-20 else items end,'hasMore',jsonb_array_length(items)>20);
  elsif action='admin.application.review' then
   rid:=(payload->>'id')::uuid; why:=trim(payload->>'reason'); decision:=payload->>'status';
   if decision not in ('approved','rejected') or coalesce(char_length(why),0) not between 1 and 1000 then raise exception 'validation'; end if;
   select * into target from public.qh_profiles where id=rid for update;
   if target.id is null then raise exception 'not_found'; end if;
   if target.role<>'member' or target.id=actor or target.status='banned' then raise exception 'forbidden'; end if;
   if target.admission_status='approved' then raise exception 'validation'; end if;
   update public.qh_applications set status=decision,review_reason=why,reviewed_by=actor,updated_at=now() where user_id=rid and status='pending';
   if not found then raise exception 'not_found'; end if;
   update public.qh_profiles set admission_status=decision where id=rid;
   insert into public.qh_audit(actor_id,action,target_id,reason) values(actor,'admission.'||decision,rid,why);
  elsif action='admin.invites.list' then
   select coalesce(jsonb_agg(value),'[]') into items from (
    select to_jsonb(i)-'code_hash' value from public.qh_invites i order by created_at desc,id limit 21 offset offset_n
   ) q;
   return jsonb_build_object('items',case when jsonb_array_length(items)>20 then items-20 else items end,'hasMore',jsonb_array_length(items)>20);
  elsif action='admin.invites.create' then
   if payload->>'code_hash' is null or payload->>'code_hint' is null or payload->>'max_uses' is null or payload->>'label' is null then raise exception 'validation'; end if;
   if (payload->>'expires_at')::timestamptz<=now() then raise exception 'validation'; end if;
   insert into public.qh_invites(code_hash,code_hint,label,max_uses,expires_at,created_by)
    values(payload->>'code_hash',payload->>'code_hint',trim(payload->>'label'),(payload->>'max_uses')::integer,(payload->>'expires_at')::timestamptz,actor) returning id into rid;
   insert into public.qh_audit(actor_id,action,target_id) values(actor,'invite.create',rid);
  elsif action='admin.invites.update' then
   rid:=(payload->>'id')::uuid;
   if jsonb_typeof(payload->'enabled')<>'boolean' or payload->'enabled' is null then raise exception 'validation'; end if;
   update public.qh_invites set enabled=(payload->>'enabled')::boolean where id=rid;
   if not found then raise exception 'not_found'; end if;
   insert into public.qh_audit(actor_id,action,target_id,reason) values(actor,'invite.update',rid,'enabled='||(payload->>'enabled'));
  end if;
  return jsonb_build_object('ok',true,'id',rid);
 end if;
 -- Prevent role promotion from accidentally admitting a pending account.
 if action='admin.user' and payload ? 'role' and exists(select 1 from public.qh_profiles where id=(payload->>'id')::uuid and admission_status<>'approved') then raise exception 'admission_required'; end if;
 return public.qh_action_admitted(actor,action,payload,aal2);
end $$;
do $$ declare t text; begin
 foreach t in array array['qh_applications','qh_invites','qh_invite_redemptions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on table public.%I from public,anon,authenticated',t);
  execute format('grant all on table public.%I to service_role',t);
 end loop;
end $$;
revoke all on function public.qh_action(uuid,text,jsonb,boolean),public.qh_reserve_ai(uuid) from public,anon,authenticated;
grant execute on function public.qh_action(uuid,text,jsonb,boolean),public.qh_reserve_ai(uuid) to service_role;
commit;

