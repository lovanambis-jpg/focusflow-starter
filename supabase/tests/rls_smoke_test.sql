-- FocusFlow RLS smoke test.
-- Run in the Supabase SQL editor AFTER applying migrations 0001, 0002 and 0003.
-- Everything happens inside one transaction that is rolled back at the end, so nothing is kept.
-- Each DO block raises an error if a check fails. If the script finishes with
-- "RLS smoke test passed" in the last result, all checks passed.

begin;

-- Two fake users. The sign-up trigger should create their profile, personal workspace and owner membership.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@test.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'bob@test.local');

do $$
begin
  assert (select count(*) from public.profiles where id in ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2')) = 2, 'profiles were not created';
  assert (select count(*) from public.workspaces where owner_id in ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2') and type = 'personal') = 2, 'personal workspaces were not created';
  assert (select count(*) from public.workspace_members where role = 'owner' and user_id in ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2')) = 2, 'owner memberships were not created';
end $$;

-- ===== Act as Alice =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

do $$
declare ws uuid;
begin
  select id into ws from public.workspaces where owner_id = '00000000-0000-0000-0000-0000000000a1';
  assert ws is not null, 'Alice cannot see her own workspace';
  perform set_config('app.alice_ws', ws::text, true);

  insert into public.tasks (workspace_id, created_by, title) values (ws, '00000000-0000-0000-0000-0000000000a1', 'Alice task');
  assert (select count(*) from public.tasks) = 1, 'Alice should see her task';

  -- Alice cannot pretend a task was created by someone else
  begin
    insert into public.tasks (workspace_id, created_by, title) values (ws, '00000000-0000-0000-0000-0000000000b2', 'Forged');
    raise exception 'FAIL: forged created_by was accepted';
  exception when insufficient_privilege or check_violation then null;
  end;

  -- created_by cannot be changed afterwards
  begin
    update public.tasks set created_by = '00000000-0000-0000-0000-0000000000b2' where title = 'Alice task';
    raise exception 'FAIL: created_by was changed';
  exception when insufficient_privilege then null;
  end;

  -- Alice cannot hand a task to someone who is not a member of the workspace
  begin
    update public.tasks set assigned_to = '00000000-0000-0000-0000-0000000000b2' where title = 'Alice task';
    raise exception 'FAIL: assigned a task to a non-member';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;

-- ===== Act as Bob =====
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);

do $$
declare ws uuid := current_setting('app.alice_ws')::uuid;
begin
  assert (select count(*) from public.tasks) = 0, 'Bob can see Alice''s tasks';
  assert (select count(*) from public.workspaces) = 1, 'Bob should only see his own workspace';
  assert (select count(*) from public.workspace_members) = 1, 'Bob should only see his own membership';
  assert (select count(*) from public.profiles) = 1, 'Bob should only see his own profile';

  begin
    insert into public.tasks (workspace_id, created_by, title) values (ws, '00000000-0000-0000-0000-0000000000b2', 'Intruder');
    raise exception 'FAIL: Bob wrote into Alice''s workspace';
  exception when insufficient_privilege or check_violation then null;
  end;

  begin
    insert into public.workspace_members (workspace_id, user_id, role) values (ws, '00000000-0000-0000-0000-0000000000b2', 'owner');
    raise exception 'FAIL: Bob added himself to Alice''s workspace';
  exception when insufficient_privilege or check_violation then null;
  end;

  update public.tasks set title = 'Hacked' where workspace_id = ws;   -- invisible rows: must change nothing
  delete from public.tasks where workspace_id = ws;                    -- same
end $$;

-- Private habit data: Bob cannot log against Alice's habit
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
do $$
declare
  ws uuid := current_setting('app.alice_ws')::uuid;
  h uuid;
begin
  insert into public.habits (workspace_id, user_id, title) values (ws, '00000000-0000-0000-0000-0000000000a1', 'Read') returning id into h;
  perform set_config('app.alice_habit', h::text, true);
  insert into public.habit_logs (habit_id, user_id, completed_on) values (h, '00000000-0000-0000-0000-0000000000a1', current_date);
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
do $$
declare h uuid := current_setting('app.alice_habit')::uuid;
begin
  assert (select count(*) from public.habits) = 0, 'Bob can see Alice''s habits';
  assert (select count(*) from public.habit_logs) = 0, 'Bob can see Alice''s habit logs';
  begin
    insert into public.habit_logs (habit_id, user_id, completed_on) values (h, '00000000-0000-0000-0000-0000000000b2', current_date);
    raise exception 'FAIL: Bob logged against Alice''s habit';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;

-- ===== Signed-out visitor (anon) =====
reset role;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.tasks;
    raise exception 'FAIL: anon can read tasks';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
rollback;

select 'RLS smoke test passed' as result;
