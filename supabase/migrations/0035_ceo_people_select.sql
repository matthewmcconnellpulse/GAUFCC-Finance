-- 0035 — the CEO can read the people register.
--
-- Login creation for employees/volunteers must work without Pulse (email
-- invites are unreliable, so an admin OR the CEO hands out sign-up links /
-- sets passwords directly — the person-login-link and invite-user functions
-- now accept both roles). The CEO therefore needs to see the people register
-- to do it. Read-only: insert/update/delete stay admin + payroll.

drop policy people_select on public.people;
create policy people_select on public.people
  for select using (
    app_private.get_role(auth.uid()) in ('pulse_admin', 'pulse_payroll', 'ceo')
    or (profile_id = auth.uid() and app_private.get_role(auth.uid()) is not null)
  );
