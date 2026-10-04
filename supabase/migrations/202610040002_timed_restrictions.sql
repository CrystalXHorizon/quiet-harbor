begin;
-- NULL keeps existing restrictions permanent; never invent a historical start.
alter table public.qh_profiles add column status_started_at timestamptz;
alter table public.qh_profiles add column status_until timestamptz;
alter table public.qh_profiles add constraint qh_profile_restriction_time
 check(status_until is null or (status in ('muted','banned') and isfinite(status_until)));
alter table public.qh_audit add column status_until timestamptz;
create index qh_restriction_expiry on public.qh_profiles(status_until) where status_until is not null;

create function public.qh_restriction_state() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status='active' then new.status_started_at:=null;new.status_until:=null;
 elsif new.status is distinct from old.status then new.status_started_at:=now();new.status_until:=null;
 end if;
 return new;
end $$;
revoke all on function public.qh_restriction_state() from public,anon,authenticated,service_role;
create trigger qh_restriction_state before update on public.qh_profiles for each row execute function public.qh_restriction_state();

create function public.qh_expire_restrictions(account uuid default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 -- Access checks wait for this account's mutations. Maintenance skips other
 -- locked accounts to avoid taking cross-user locks while an actor is locked.
 if account is not null then perform 1 from public.qh_profiles where id=account for update;end if;
 with due as materialized (
  select id,status_until from public.qh_profiles
  where status in ('muted','banned') and status_until<=now() and (account is null or id=account)
  order by status_until,id limit 1000 for update skip locked
 ), restored as (
  update public.qh_profiles p set status='active' from due d where p.id=d.id
  returning p.id,d.status_until
 ) insert into public.qh_audit(actor_id,action,target_id,reason,status_until)
  select null,'user.restriction.expired',id,'限时禁言或封禁已到期，自动恢复正常。',status_until from restored;
end $$;
revoke all on function public.qh_expire_restrictions(uuid) from public,anon,authenticated,service_role;

alter function public.qh_action(uuid,text,jsonb,boolean,uuid) rename to qh_action_before_timed_restrictions;
revoke all on function public.qh_action_before_timed_restrictions(uuid,text,jsonb,boolean,uuid) from public,anon,authenticated,service_role;
create function public.qh_action(actor uuid,action text,payload jsonb default '{}',aal2 boolean default false,auth_session uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;t public.qh_profiles;until_at timestamptz;seconds integer;has_time boolean;
begin
 perform public.qh_expire_restrictions(actor);
 if action='admin.user' then
  perform public.qh_expire_restrictions((payload->>'id')::uuid);
  select * into t from public.qh_profiles where id=(payload->>'id')::uuid for update;
 end if;
 -- Existing role, admission, MFA, self/owner and moderation checks remain the
 -- authority. Invalid timing rolls the entire adjustment and its audit back.
 r:=public.qh_action_before_timed_restrictions(actor,action,payload,aal2,auth_session);
 if action='admin.user' then
  has_time:=payload ? 'duration_seconds' or payload ? 'status_until';
  if payload ? 'status' and payload->>'status' not in ('active','muted','banned') then raise exception 'validation';end if;
  if has_time and (coalesce(payload->>'status','active') not in ('muted','banned') or (payload ? 'duration_seconds' and payload ? 'status_until')) then raise exception 'validation';end if;
  if payload->>'status' in ('muted','banned') then
   if not has_time and payload->>'status' is distinct from t.status then raise exception 'validation';end if;
   if payload ? 'duration_seconds' then
    if jsonb_typeof(payload->'duration_seconds')<>'number' or (payload->>'duration_seconds') !~ '^[0-9]+$' then raise exception 'validation';end if;
    seconds:=(payload->>'duration_seconds')::integer;
    if seconds not between 60 and 31536000 then raise exception 'validation';end if;
    until_at:=now()+make_interval(secs=>seconds);
   elsif payload ? 'status_until' and payload->'status_until'<>'null'::jsonb then
    if jsonb_typeof(payload->'status_until')<>'string' or (payload->>'status_until') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' then raise exception 'validation';end if;
    begin until_at:=(payload->>'status_until')::timestamptz;exception when others then raise exception 'validation';end;
    if not isfinite(until_at) or until_at<=now() or until_at>now()+interval '365 days' then raise exception 'validation';end if;
   end if;
   if has_time then
    update public.qh_profiles set status_started_at=now(),status_until=until_at where id=t.id;
   end if;
  end if;
  select * into t from public.qh_profiles where id=t.id;
  update public.qh_audit set status_until=t.status_until
   where id=(select max(a.id) from public.qh_audit a where a.actor_id=actor and a.target_id=t.id and a.action like 'user.%');
  r:=r||jsonb_build_object('profile',to_jsonb(t)-'bio'-'public_bio');
 end if;
 return r;
end $$;
revoke all on function public.qh_action(uuid,text,jsonb,boolean,uuid) from public,anon,authenticated;
grant execute on function public.qh_action(uuid,text,jsonb,boolean,uuid) to service_role;

-- Direct service RPCs enforce the same expiration as the authenticated API.
alter function public.qh_reserve_model(uuid,text) rename to qh_reserve_model_before_timed_restrictions;
revoke all on function public.qh_reserve_model_before_timed_restrictions(uuid,text) from public,anon,authenticated,service_role;
create function public.qh_reserve_model(actor uuid,kind text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.qh_expire_restrictions(actor);
 return public.qh_reserve_model_before_timed_restrictions(actor,kind);
end $$;
revoke all on function public.qh_reserve_model(uuid,text) from public,anon,authenticated;
grant execute on function public.qh_reserve_model(uuid,text) to service_role;

alter function public.qh_email_mfa(uuid,uuid,text,jsonb) rename to qh_email_mfa_before_timed_restrictions;
revoke all on function public.qh_email_mfa_before_timed_restrictions(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
create function public.qh_email_mfa(actor uuid,auth_session uuid,operation text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.qh_expire_restrictions(actor);
 return public.qh_email_mfa_before_timed_restrictions(actor,auth_session,operation,payload);
end $$;
revoke all on function public.qh_email_mfa(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.qh_email_mfa(uuid,uuid,text,jsonb) to service_role;

alter function public.qh_cleanup() rename to qh_cleanup_before_timed_restrictions;
revoke all on function public.qh_cleanup_before_timed_restrictions() from public,anon,authenticated,service_role;
create function public.qh_cleanup() returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.qh_cleanup_before_timed_restrictions();
 perform public.qh_expire_restrictions();
end $$;
revoke all on function public.qh_cleanup() from public,anon,authenticated;
grant execute on function public.qh_cleanup() to service_role;
create or replace function public.qh_backend_version() returns jsonb language sql stable security definer set search_path='' as $$ select '{"schema":"202610040002"}'::jsonb $$;
commit;
