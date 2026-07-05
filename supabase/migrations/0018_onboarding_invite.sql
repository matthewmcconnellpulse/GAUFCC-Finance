-- 0018 — create_onboarding_token RPC
-- Closes the loop between the People UI and the service-role-only
-- onboarding_tokens table: pulse_admin / pulse_payroll create an invite from
-- the browser; the token row and the 'invited' people row are created in one
-- SECURITY DEFINER transaction, and the raw token is returned once for the
-- shareable link. The public onboarding edge function later updates the
-- linked people row on submission.

create or replace function public.create_onboarding_token(
  p_email text,
  p_person_type public.person_type,
  p_full_name text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.role := app_private.get_role(auth.uid());
  v_person_id uuid;
  v_token text;
  v_first text;
  v_last text;
  v_email text := lower(trim(p_email));
begin
  if v_role is null or v_role not in ('pulse_admin', 'pulse_payroll') then
    raise exception 'not authorised to create onboarding invites' using errcode = '42501';
  end if;

  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'a valid email address is required';
  end if;

  -- Split the display name on the first space; both parts optional.
  v_first := coalesce(nullif(trim(split_part(coalesce(p_full_name, ''), ' ', 1)), ''), '');
  v_last := nullif(trim(substr(coalesce(p_full_name, ''), length(split_part(coalesce(p_full_name, ''), ' ', 1)) + 1)), '');

  insert into public.people (type, first_name, last_name, email, onboarding_status)
  values (p_person_type, v_first, coalesce(v_last, ''), v_email, 'invited')
  returning id into v_person_id;

  insert into public.onboarding_tokens (person_id, person_type, email, created_by)
  values (v_person_id, p_person_type, v_email, auth.uid())
  returning token into v_token;

  insert into public.audit_log (actor_id, action, entity, entity_id, after)
  values (
    auth.uid(),
    'onboarding_invited',
    'people',
    v_person_id::text,
    jsonb_build_object('email', v_email, 'person_type', p_person_type)
  );

  return v_token;
end;
$$;

comment on function public.create_onboarding_token(text, public.person_type, text) is
  'Creates an onboarding invite: people row (status invited) + single-use token. pulse_admin/pulse_payroll only; audit-logged; returns the raw token exactly once.';

revoke all on function public.create_onboarding_token(text, public.person_type, text) from public;
revoke all on function public.create_onboarding_token(text, public.person_type, text) from anon;
grant execute on function public.create_onboarding_token(text, public.person_type, text) to authenticated, service_role;
