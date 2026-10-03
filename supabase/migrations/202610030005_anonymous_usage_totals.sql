begin;
-- Keep aggregate operational counts after the associated account is erased.
-- These UTC-day totals contain no account identifiers or content.
alter table public.qh_global_usage add column provider_calls bigint not null default 0;
alter table public.qh_global_usage add column chat_turns bigint not null default 0;
alter table public.qh_global_usage add column moderation_used bigint not null default 0;
update public.qh_global_usage g set provider_calls=u.provider_calls,chat_turns=u.chat_turns,moderation_used=u.moderation_used
 from (select day,sum(provider_calls) provider_calls,sum(chat_turns) chat_turns,sum(moderation_used) moderation_used from public.qh_usage group by day) u where u.day=g.day;

create or replace function public.qh_reserve_model(actor uuid,kind text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.qh_profiles;s public.qh_ai_settings;n integer;total bigint;d date:=(now() at time zone 'UTC')::date;begin
 select * into u from public.qh_profiles where id=actor for update;
 if u.id is null or u.status='banned' then raise exception 'forbidden';end if;
 if u.admission_status<>'approved' then raise exception 'admission_required';end if;
 if kind is null or kind not in ('chat','moderation','test') then raise exception 'validation';end if;
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
 update public.qh_global_usage set used=used+1,moderation_used=moderation_used+case when kind='moderation' then 1 else 0 end where day=d;
 return jsonb_build_object('config',s.config,'encrypted_key',s.encrypted_key);
end $$;
create or replace function public.qh_record_ai_call(actor uuid,kind text,start_turn boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare d date:=(now() at time zone 'UTC')::date;begin
 -- Reservations take the global lock before the user-usage lock. Keep that
 -- same order to avoid deadlocks with concurrent reservations.
 perform 1 from public.qh_global_usage where day=d for update;
 update public.qh_usage set provider_calls=provider_calls+1,chat_turns=chat_turns+case when kind='chat' and start_turn then 1 else 0 end
  where user_id=actor and day=d and provider_calls<used;
 if not found then raise exception 'quota_exceeded';end if;
 update public.qh_global_usage set provider_calls=provider_calls+1,chat_turns=chat_turns+case when kind='chat' and start_turn then 1 else 0 end where day=d;
end $$;
alter function public.qh_action(uuid,text,jsonb,boolean) rename to qh_action_before_usage_totals;
revoke all on function public.qh_action_before_usage_totals(uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;
create function public.qh_action(actor uuid,action text,payload jsonb default '{}',aal2 boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;g public.qh_global_usage;begin
 r:=public.qh_action_before_usage_totals(actor,action,payload,aal2);
 if action='admin.usage' then
  select * into g from public.qh_global_usage where day=(now() at time zone 'UTC')::date;
  r:=r||jsonb_build_object('provider_calls',coalesce(g.provider_calls,0),'chat_turns',coalesce(g.chat_turns,0),'moderation_used',coalesce(g.moderation_used,0));
 end if;
 return r;
end $$;
revoke all on function public.qh_action(uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.qh_action(uuid,text,jsonb,boolean) to service_role;
create or replace function public.qh_backend_version() returns jsonb language sql stable security definer set search_path='' as $$ select '{"schema":"202610030005"}'::jsonb $$;
commit;
