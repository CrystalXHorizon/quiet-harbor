begin;
-- Email proof is application-level MFA, never a fabricated Supabase AAL2 JWT.
-- Only the verified Edge gateway can issue challenges or attach a session grant.
create table public.qh_email_mfa_settings(
 user_id uuid primary key references public.qh_profiles(id) on delete cascade,
 enabled boolean not null default false,
 last_send_at timestamptz not null default '-infinity',
 send_window_start timestamptz not null default '-infinity',
 send_count integer not null default 0 check(send_count between 0 and 5)
);
create table public.qh_email_mfa_challenges(
 user_id uuid primary key references public.qh_profiles(id) on delete cascade,
 session_id uuid not null,challenge_id uuid not null unique,
 email text not null,code_hash text check(code_hash ~ '^[0-9a-f]{64}$'),
 requested_at timestamptz not null default now(),expires_at timestamptz not null,
 attempts integer not null default 0 check(attempts between 0 and 5)
);
create table public.qh_email_mfa_sessions(
 user_id uuid not null references public.qh_profiles(id) on delete cascade,
 session_id uuid not null,email text not null,verified_until timestamptz not null,
 primary key(user_id,session_id)
);
alter table public.qh_email_mfa_settings enable row level security;
alter table public.qh_email_mfa_challenges enable row level security;
alter table public.qh_email_mfa_sessions enable row level security;
revoke all on public.qh_email_mfa_settings,public.qh_email_mfa_challenges,public.qh_email_mfa_sessions from public,anon,authenticated;
grant all on public.qh_email_mfa_settings,public.qh_email_mfa_challenges,public.qh_email_mfa_sessions to service_role;

create function public.qh_email_mfa_verified(actor uuid,auth_session uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.qh_email_mfa_sessions s join auth.users u on u.id=s.user_id
  join auth.sessions a on a.id=s.session_id and a.user_id=s.user_id and (a.not_after is null or a.not_after>now())
  join public.qh_email_mfa_settings m on m.user_id=s.user_id and m.enabled
  where s.user_id=actor and s.session_id=auth_session and s.email=u.email and s.verified_until>now())
$$;
revoke all on function public.qh_email_mfa_verified(uuid,uuid) from public,anon,authenticated,service_role;

create function public.qh_email_mfa(actor uuid,auth_session uuid,operation text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare u public.qh_profiles;e text;c public.qh_email_mfa_challenges;s public.qh_email_mfa_settings;v timestamptz;begin
 select * into u from public.qh_profiles where id=actor for update;
 select email into e from auth.users where id=actor;
 if u.id is null or e is null then raise exception 'unauthorized';end if;
 if operation='status' then
  select verified_until into v from public.qh_email_mfa_sessions where user_id=actor and session_id=auth_session and email=e and verified_until>now();
  return jsonb_build_object('email_enabled',coalesce((select enabled from public.qh_email_mfa_settings where user_id=actor),false),
   'email_verified',public.qh_email_mfa_verified(actor,auth_session),'verified_until',v);
 end if;
 if auth_session is null then raise exception 'password_required';end if;
 if not exists(select 1 from auth.sessions where id=auth_session and user_id=actor and (not_after is null or not_after>now())) then raise exception 'unauthorized';end if;
 if u.status='banned' then raise exception 'forbidden';end if;
 if operation in ('authorize_password','revoke_sessions') then
  if coalesce((payload->>'native_mfa')::boolean,false) is not true and not public.qh_email_mfa_verified(actor,auth_session) then raise exception 'mfa_required';end if;
  if operation='authorize_password' then perform public.qh_rate(actor,'password_change',3,3600);
  else delete from public.qh_email_mfa_sessions where user_id=actor;delete from public.qh_email_mfa_challenges where user_id=actor;end if;
  return '{"ok":true}';
 end if;
 if operation='disable' then
  if coalesce((payload->>'native_mfa')::boolean,false) is not true and not public.qh_email_mfa_verified(actor,auth_session) then raise exception 'mfa_required';end if;
  update public.qh_email_mfa_settings set enabled=false where user_id=actor;
  delete from public.qh_email_mfa_sessions where user_id=actor;
  delete from public.qh_email_mfa_challenges where user_id=actor;
  return '{"ok":true}';
 end if;
 select * into c from public.qh_email_mfa_challenges where user_id=actor for update;
 if operation='start' then
  if payload->>'email' is distinct from e or coalesce(payload->>'code_hash','') !~ '^[0-9a-f]{64}$' or payload->>'challenge_id' is null then raise exception 'validation';end if;
  insert into public.qh_email_mfa_settings(user_id) values(actor) on conflict do nothing;
  select * into s from public.qh_email_mfa_settings where user_id=actor for update;
  if s.last_send_at>now()-interval '60 seconds' then raise exception 'rate_limit';end if;
  if s.send_window_start>now()-interval '1 hour' and s.send_count>=5 then raise exception 'rate_limit';end if;
  update public.qh_email_mfa_settings set last_send_at=now(),
   send_count=case when s.send_window_start<=now()-interval '1 hour' then 1 else s.send_count+1 end,
   send_window_start=case when s.send_window_start<=now()-interval '1 hour' then now() else s.send_window_start end where user_id=actor;
  insert into public.qh_email_mfa_challenges(user_id,session_id,challenge_id,email,code_hash,expires_at)
   values(actor,auth_session,(payload->>'challenge_id')::uuid,e,payload->>'code_hash',now()+interval '5 minutes')
   on conflict(user_id) do update set session_id=excluded.session_id,challenge_id=excluded.challenge_id,email=excluded.email,
    code_hash=excluded.code_hash,requested_at=now(),expires_at=excluded.expires_at,attempts=0;
  return jsonb_build_object('challenge_id',payload->>'challenge_id','expires_at',now()+interval '5 minutes','retry_after',60);
 elsif operation='cancel' then
  update public.qh_email_mfa_challenges set code_hash=null,expires_at=now() where user_id=actor and session_id=auth_session and challenge_id=(payload->>'challenge_id')::uuid;
  return '{"ok":true}';
 elsif operation='verify' then
  if c.user_id is null or c.session_id<>auth_session or c.email<>e or c.challenge_id is distinct from (payload->>'challenge_id')::uuid
   or c.code_hash is null or c.expires_at<=now() or c.attempts>=5 then return '{"error_code":"email_code_invalid"}';end if;
  -- Return a failure value, rather than raising: failed attempts must COMMIT.
  update public.qh_email_mfa_challenges set attempts=attempts+1 where user_id=actor;
  if c.code_hash is distinct from payload->>'code_hash' then return '{"error_code":"email_code_invalid"}';end if;
  update public.qh_email_mfa_challenges set code_hash=null,expires_at=now() where user_id=actor;
  insert into public.qh_email_mfa_settings(user_id,enabled) values(actor,true) on conflict(user_id) do update set enabled=true;
  v:=now()+interval '12 hours';
  insert into public.qh_email_mfa_sessions(user_id,session_id,email,verified_until) values(actor,auth_session,e,v)
   on conflict(user_id,session_id) do update set email=excluded.email,verified_until=excluded.verified_until;
  return jsonb_build_object('ok',true,'verified_until',v);
 end if;
 raise exception 'validation';
end $$;
revoke all on function public.qh_email_mfa(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.qh_email_mfa(uuid,uuid,text,jsonb) to service_role;

alter function public.qh_action(uuid,text,jsonb,boolean) rename to qh_action_before_email_mfa;
revoke all on function public.qh_action_before_email_mfa(uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;
create function public.qh_action(actor uuid,action text,payload jsonb default '{}',aal2 boolean default false,auth_session uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare verified boolean;begin
 -- Serialize grants/settings with authorization, so a queued action cannot
 -- retain a proof that was revoked while it waited for the profile lock.
 perform 1 from public.qh_profiles where id=actor for update;
 verified:=coalesce(aal2,false) or public.qh_email_mfa_verified(actor,auth_session);
 if not verified and exists(select 1 from public.qh_email_mfa_settings where user_id=actor and enabled) then raise exception 'mfa_required';end if;
 return public.qh_action_before_email_mfa(actor,action,payload,verified);
end $$;
revoke all on function public.qh_action(uuid,text,jsonb,boolean,uuid) from public,anon,authenticated;
grant execute on function public.qh_action(uuid,text,jsonb,boolean,uuid) to service_role;

alter function public.qh_cleanup() rename to qh_cleanup_before_email_mfa;
revoke all on function public.qh_cleanup_before_email_mfa() from public,anon,authenticated,service_role;
create function public.qh_cleanup() returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.qh_cleanup_before_email_mfa();
 delete from public.qh_email_mfa_challenges where requested_at<now()-interval '1 day';
 delete from public.qh_email_mfa_sessions where verified_until<=now();
end $$;
revoke all on function public.qh_cleanup() from public,anon,authenticated;
grant execute on function public.qh_cleanup() to service_role;
create or replace function public.qh_backend_version() returns jsonb language sql stable security definer set search_path='' as $$ select '{"schema":"202610040001"}'::jsonb $$;
commit;
