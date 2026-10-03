begin;
-- Review and content changes share a single transaction and existing role/MFA rules.
create function public.qh_review_snapshot(post_id uuid,comment_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select case when $2 is not null then
  (select jsonb_build_object('title',p.title,'body',c.body,'status',c.status,'job_id',c.moderation_job_id,'parent_status',p.status)
   from public.qh_comments c join public.qh_posts p on p.id=c.post_id where c.id=$2 and c.post_id=$1 and c.deleted_at is null and p.deleted_at is null)
 else
  (select jsonb_build_object('title',case when p.revision_status in ('pending','rejected') then p.pending_revision->>'title' else p.title end,
   'body',case when p.revision_status in ('pending','rejected') then p.pending_revision->>'body' else p.body end,
   'status',p.status,'revision_status',p.revision_status,'job_id',p.moderation_job_id)
   from public.qh_posts p where p.id=$1 and p.deleted_at is null and p.status<>'draft') end;
$$;
revoke all on function public.qh_review_snapshot(uuid,uuid) from public,anon,authenticated,service_role;
alter table public.qh_appeals add column content_snapshot jsonb;
alter table public.qh_reports add column content_snapshot jsonb;
update public.qh_appeals a set content_snapshot=public.qh_review_snapshot(a.post_id,a.comment_id) where a.status='open';
update public.qh_reports r set content_snapshot=public.qh_review_snapshot(r.post_id,r.comment_id) where r.status='open';
alter function public.qh_action(uuid,text,jsonb,boolean) rename to qh_action_before_resolution;
revoke all on function public.qh_action_before_resolution(uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;
create function public.qh_action(actor uuid,action text,payload jsonb default '{}',aal2 boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; entry jsonb; current_content jsonb; saved_content jsonb; enriched jsonb; list_key text;
 rid uuid; pid uuid; cid uuid; why text; target_kind text; next_decision text;
begin
 if action='admin.moderate' and ((payload->>'kind'='appeal' and payload->>'decision'='restore') or (payload->>'kind'='report' and payload->>'decision'='hide')) then
  perform public.qh_action_before_resolution(actor,'admin.queue','{}',aal2);
  if not aal2 then raise exception 'mfa_required';end if;
  why:=trim(payload->>'reason');rid:=(payload->>'id')::uuid;
  if coalesce(char_length(why),0) not between 1 and 1000 then raise exception 'validation';end if;
  if payload->>'kind'='appeal' then
   select a.post_id,a.comment_id,a.content_snapshot into pid,cid,saved_content from public.qh_appeals a where a.id=rid and a.status='open' for update;
   next_decision:='approve';
  else
   select x.post_id,x.comment_id,x.content_snapshot into pid,cid,saved_content from public.qh_reports x where x.id=rid and x.status='open' for update;
   next_decision:='hide';
  end if;
  if pid is null then raise exception 'not_found';end if;
  -- Lock the target before checking that this is the version the reviewer saw.
  if cid is null then perform 1 from public.qh_posts where id=pid for update;target_kind:='post';
  else perform 1 from public.qh_posts where id=pid for update;perform 1 from public.qh_comments where id=cid for update;target_kind:='comment';end if;
  current_content:=public.qh_review_snapshot(pid,cid);
  if current_content is null then raise exception 'not_found';end if;
  if current_content is distinct from saved_content then raise exception 'content_changed';end if;
  if cid is not null and current_content->>'parent_status'<>'published' then raise exception 'not_found';end if;
  if next_decision='approve' and not(current_content->>'status' in ('rejected','hidden') or coalesce(current_content->>'revision_status'='rejected',false)) then raise exception 'validation';end if;
  perform public.qh_action_before_resolution(actor,'admin.moderate',jsonb_build_object('kind',target_kind,'id',coalesce(cid,pid),'decision',next_decision,'reason',why),aal2);
  r:=public.qh_action_before_resolution(actor,'admin.moderate',payload||jsonb_build_object('decision','resolve'),aal2);
  return r||jsonb_build_object('content_updated',true);
 end if;
 r:=public.qh_action_before_resolution(actor,action,payload,aal2);
 if action='appeals.create' then
  update public.qh_appeals a set content_snapshot=public.qh_review_snapshot(a.post_id,a.comment_id) where a.id=(r->>'id')::uuid;
 elsif action='reports.create' then
  update public.qh_reports x set content_snapshot=public.qh_review_snapshot(x.post_id,x.comment_id) where x.id=(r->>'id')::uuid;
 elsif action='admin.queue' then
  foreach list_key in array array['appeals','reports'] loop
   enriched:='[]';
   for entry in select value from jsonb_array_elements(r->list_key) loop
    pid:=(entry->>'post_id')::uuid;cid:=(entry->>'comment_id')::uuid;
    current_content:=public.qh_review_snapshot(pid,cid);saved_content:=entry->'content_snapshot';
    entry:=entry||jsonb_build_object('target_kind',case when cid is null then 'post' else 'comment' end,
     'target_author_id',case when cid is null then (select p.author_id from public.qh_posts p where p.id=pid) else (select c.author_id from public.qh_comments c where c.id=cid) end,
     'target_title',saved_content->>'title','target_body',saved_content->>'body',
     'target_status',current_content->>'status','revision_status',current_content->>'revision_status',
     'content_changed',current_content is distinct from saved_content,
     'can_restore',current_content is not null and current_content=saved_content and (cid is null or current_content->>'parent_status'='published') and
       (current_content->>'status' in ('rejected','hidden') or coalesce(current_content->>'revision_status'='rejected',false)),
     'can_hide',current_content is not null and current_content=saved_content and (cid is null or current_content->>'parent_status'='published'),
     'target_reason',case when cid is null then (select p.reason from public.qh_posts p where p.id=pid) else (select c.reason from public.qh_comments c where c.id=cid) end,
     'moderation',(select jsonb_build_object('status',j.status,'reason',j.reason,'rule_ids',j.rule_ids,'policy_version',j.policy_version,'model',j.model) from public.qh_moderation_jobs j where j.id=nullif(saved_content->>'job_id','')::uuid));
    enriched:=enriched||jsonb_build_array(entry);
   end loop;
   r:=jsonb_set(r,array[list_key],enriched);
  end loop;
 end if;
 return r;
end $$;
revoke all on function public.qh_action(uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.qh_action(uuid,text,jsonb,boolean) to service_role;
commit;
