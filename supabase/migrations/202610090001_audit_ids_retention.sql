begin;
-- Retain audit identifiers until the existing 180-day cleanup removes the event.
-- Erasure still removes account/content data and potentially identifying reasons.
create or replace function public.qh_erase_account_attribution() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 update public.qh_audit set reason='' where actor_id=old.id or target_id=old.id;
 return old;
end $$;
revoke all on function public.qh_erase_account_attribution() from public,anon,authenticated,service_role;

alter function public.qh_action(uuid,text,jsonb,boolean,uuid) rename to qh_action_before_audit_ids;
revoke all on function public.qh_action_before_audit_ids(uuid,text,jsonb,boolean,uuid) from public,anon,authenticated,service_role;
create function public.qh_action(actor uuid,action text,payload jsonb default '{}',aal2 boolean default false,auth_session uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;
begin
 -- The existing implementation checks roles/MFA and holds the actor's profile
 -- lock through deletion and audit insertion, serializing this actor's actions.
 r:=public.qh_action_before_audit_ids(actor,action,payload,aal2,auth_session);
 if action='admin.purge' then
  update public.qh_audit set target_id=(payload->>'id')::uuid
   where id=(select max(e.id) from public.qh_audit e where e.actor_id=actor and e.action='admin.purge');
 end if;
 return r;
end $$;
revoke all on function public.qh_action(uuid,text,jsonb,boolean,uuid) from public,anon,authenticated;
grant execute on function public.qh_action(uuid,text,jsonb,boolean,uuid) to service_role;
create or replace function public.qh_backend_version() returns jsonb language sql stable security definer set search_path='' as $$ select '{"schema":"202610090001"}'::jsonb $$;
commit;
