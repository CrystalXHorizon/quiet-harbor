begin;
-- Resolve display names only after the existing owner/MFA authorization succeeds.
-- Names and titles remain in their source rows; erasure does not retain copies.
alter function public.qh_action(uuid,text,jsonb,boolean,uuid) rename to qh_action_before_audit_names;
revoke all on function public.qh_action_before_audit_names(uuid,text,jsonb,boolean,uuid) from public,anon,authenticated,service_role;
create function public.qh_action(actor uuid,action text,payload jsonb default '{}',aal2 boolean default false,auth_session uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;events jsonb;
begin
 r:=public.qh_action_before_audit_names(actor,action,payload,aal2,auth_session);
 if action='admin.audit' then
  with entries as (
   select e.value,e.ordinality,(e.value->>'actor_id')::uuid actor_id,(e.value->>'target_id')::uuid target_id,
    case
     when e.value->>'action'='admission.invite' then 'invite'
     when e.value->>'action' like 'user.%' or e.value->>'action' like 'admission.%' or e.value->>'action' in ('admin.user','admin.purge') then 'user'
     when e.value->>'action' like 'posts.%' or e.value->>'action' like 'moderate.post.%' then 'post'
     when e.value->>'action' like 'comments.%' or e.value->>'action' like 'moderate.comment.%' then 'comment'
     when e.value->>'action' like 'moderate.report.%' then 'report'
     when e.value->>'action' like 'moderate.appeal.%' then 'appeal'
     when e.value->>'action' like 'invite.%' then 'invite'
     when e.value->>'action' like 'moderation.ai.%' then
      case when exists(select 1 from public.qh_posts p where p.id=(e.value->>'target_id')::uuid) then 'post'
       when exists(select 1 from public.qh_comments c where c.id=(e.value->>'target_id')::uuid) then 'comment' else 'content' end
     else 'object'
    end kind
   from jsonb_array_elements(coalesce(r->'events','[]'::jsonb)) with ordinality e(value,ordinality)
  )
  select coalesce(jsonb_agg(e.value||jsonb_build_object(
   'actor_nickname',operator.nickname,'target_kind',e.kind,
   'target_nickname',case when e.kind='user' then member.nickname else author.nickname end,
   'target_label',case when e.kind='user' then member.nickname when e.kind='post' then p.title
    when e.kind in ('comment','report','appeal') then context_post.title when e.kind='invite' then i.label else null end,
   'target_exists',case e.kind when 'user' then member.id is not null when 'post' then p.id is not null
    when 'comment' then c.id is not null when 'report' then report.id is not null when 'appeal' then appeal.id is not null
    when 'invite' then i.id is not null else false end
  ) order by e.ordinality),'[]'::jsonb) into events
  from entries e
  left join public.qh_profiles operator on operator.id=e.actor_id
  left join public.qh_profiles member on member.id=e.target_id and e.kind='user'
  left join public.qh_posts p on p.id=e.target_id and e.kind='post'
  left join public.qh_comments c on c.id=e.target_id and e.kind='comment'
  left join public.qh_reports report on report.id=e.target_id and e.kind='report'
  left join public.qh_appeals appeal on appeal.id=e.target_id and e.kind='appeal'
  left join public.qh_invites i on i.id=e.target_id and e.kind='invite'
  left join public.qh_profiles author on author.id=coalesce(p.author_id,c.author_id,report.author_id,appeal.author_id,i.created_by)
  left join public.qh_posts context_post on context_post.id=coalesce(c.post_id,report.post_id,appeal.post_id);
  r:=r||jsonb_build_object('events',events);
 end if;
 return r;
end $$;
revoke all on function public.qh_action(uuid,text,jsonb,boolean,uuid) from public,anon,authenticated;
grant execute on function public.qh_action(uuid,text,jsonb,boolean,uuid) to service_role;
create or replace function public.qh_backend_version() returns jsonb language sql stable security definer set search_path='' as $$ select '{"schema":"202610090002"}'::jsonb $$;
commit;
