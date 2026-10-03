begin;
-- Legacy admin.users serializes the entire profile row; new private fields must
-- remain visible only through the member's own me/profile endpoints.
alter function public.qh_action(uuid,text,jsonb,boolean) rename to qh_action_before_profile_privacy;
revoke all on function public.qh_action_before_profile_privacy(uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;
create function public.qh_action(actor uuid,action text,payload jsonb default '{}',aal2 boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;users jsonb;
begin
 result:=public.qh_action_before_profile_privacy(actor,action,payload,aal2);
 if action='admin.users' then
  select coalesce(jsonb_agg(value-'bio'-'public_bio' order by ord),'[]') into users from jsonb_array_elements(result->'users') with ordinality as listed(value,ord);
  result:=jsonb_set(result,'{users}',users);
 end if;
 return result;
end $$;
revoke all on function public.qh_action(uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.qh_action(uuid,text,jsonb,boolean) to service_role;
commit;
