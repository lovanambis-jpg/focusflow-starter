-- FocusFlow RLS policies (apply after 0001 and 0002).
-- Model: a user belongs to one or more workspaces through workspace_members.
--   owner / admin : manage the workspace, its members, and all of its tasks
--   member        : create and edit tasks
--   viewer        : read tasks only
-- Habits, habit logs and focus sessions are private to the user who owns them.
-- Anonymous (not signed in) users get no access to any table.

-- ---------------------------------------------------------------------------
-- 0) Helper functions.
--    SECURITY DEFINER so that policies on workspace_members can ask "am I a member?"
--    without recursing into their own policy. search_path is pinned for safety.
-- ---------------------------------------------------------------------------
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_workspace_role(ws uuid, roles text[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role = any (roles)
  );
$$;

create or replace function public.shares_workspace_with(other uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members a
    join public.workspace_members b on b.workspace_id = a.workspace_id
    where a.user_id = (select auth.uid()) and b.user_id = other
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.has_workspace_role(uuid, text[]) from public, anon;
revoke all on function public.shares_workspace_with(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, text[]) to authenticated;
grant execute on function public.shares_workspace_with(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1) Triggers
-- ---------------------------------------------------------------------------
-- Whoever creates a workspace becomes its owner member (also covers the personal
-- workspace created at sign-up).
create or replace function public.add_owner_membership()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_workspaces_owner_member on public.workspaces;
create trigger trg_workspaces_owner_member after insert on public.workspaces
  for each row execute function public.add_owner_membership();

-- Redefine the sign-up trigger from 0002: the membership row now comes from the trigger above.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)));

  insert into public.workspaces (name, type, owner_id)
  values ('Personal', 'personal', new.id);

  return new;
end;
$$;

-- Columns that must never change after creation (RLS cannot compare old and new rows).
create or replace function public.forbid_column_change()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  col text;
begin
  foreach col in array tg_argv loop
    if to_jsonb(new) ->> col is distinct from to_jsonb(old) ->> col then
      raise exception 'column "%" cannot be changed', col using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_workspaces_immutable on public.workspaces;
create trigger trg_workspaces_immutable before update on public.workspaces
  for each row execute function public.forbid_column_change('owner_id');

drop trigger if exists trg_members_immutable on public.workspace_members;
create trigger trg_members_immutable before update on public.workspace_members
  for each row execute function public.forbid_column_change('workspace_id', 'user_id');

drop trigger if exists trg_tasks_immutable on public.tasks;
create trigger trg_tasks_immutable before update on public.tasks
  for each row execute function public.forbid_column_change('workspace_id', 'created_by');

drop trigger if exists trg_habits_immutable on public.habits;
create trigger trg_habits_immutable before update on public.habits
  for each row execute function public.forbid_column_change('workspace_id', 'user_id');

-- ---------------------------------------------------------------------------
-- 2) Table privileges: signed-out visitors get nothing.
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.workspaces, public.workspace_members,
              public.tasks, public.habits, public.habit_logs, public.focus_sessions
  from anon;
grant select, insert, update, delete on public.profiles, public.workspaces, public.workspace_members,
              public.tasks, public.habits, public.habit_logs, public.focus_sessions
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Policies (drop first so the file can be re-run)
-- ---------------------------------------------------------------------------
-- profiles: see yourself and people you share a workspace with; edit only yourself.
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_workspace_with(id));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- workspaces
drop policy if exists workspaces_select on public.workspaces;
drop policy if exists workspaces_insert on public.workspaces;
drop policy if exists workspaces_update on public.workspaces;
drop policy if exists workspaces_delete on public.workspaces;
create policy workspaces_select on public.workspaces for select to authenticated
  using (public.is_workspace_member(id) or owner_id = (select auth.uid()));
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (owner_id = (select auth.uid()) and type = 'team');   -- personal workspaces come from the sign-up trigger
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.has_workspace_role(id, array['owner', 'admin']))
  with check (public.has_workspace_role(id, array['owner', 'admin']));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (type = 'team' and public.has_workspace_role(id, array['owner']));

-- workspace_members
drop policy if exists members_select on public.workspace_members;
drop policy if exists members_insert on public.workspace_members;
drop policy if exists members_update on public.workspace_members;
drop policy if exists members_delete on public.workspace_members;
create policy members_select on public.workspace_members for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy members_insert on public.workspace_members for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin'])
    and (role <> 'owner' or public.has_workspace_role(workspace_id, array['owner']))
  );
create policy members_update on public.workspace_members for update to authenticated
  using (
    public.has_workspace_role(workspace_id, array['owner', 'admin'])
    and (role <> 'owner' or public.has_workspace_role(workspace_id, array['owner']))
  )
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin'])
    and (role <> 'owner' or public.has_workspace_role(workspace_id, array['owner']))
  );
create policy members_delete on public.workspace_members for delete to authenticated
  using (
    -- the workspace's creator can never be removed, by anyone
    user_id <> (select w.owner_id from public.workspaces w where w.id = workspace_members.workspace_id)
    and (
      user_id = (select auth.uid())                                          -- leave a workspace
      or (public.has_workspace_role(workspace_id, array['owner', 'admin'])   -- remove someone else
          and (role <> 'owner' or public.has_workspace_role(workspace_id, array['owner'])))
    )
  );

-- tasks (rows with deleted_at set stay readable so a future sync can see deletions)
drop policy if exists tasks_select on public.tasks;
drop policy if exists tasks_insert on public.tasks;
drop policy if exists tasks_update on public.tasks;
drop policy if exists tasks_delete on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])
    and created_by = (select auth.uid())
    and (assigned_to is null or exists (
          select 1 from public.workspace_members m
          where m.workspace_id = tasks.workspace_id and m.user_id = tasks.assigned_to))
  );
create policy tasks_update on public.tasks for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'member']))
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'member'])
    and (assigned_to is null or exists (
          select 1 from public.workspace_members m
          where m.workspace_id = tasks.workspace_id and m.user_id = tasks.assigned_to))
  );
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

-- habits: private to the user
drop policy if exists habits_own on public.habits;
create policy habits_own on public.habits for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- habit_logs: private, and the habit itself must belong to the same user
drop policy if exists habit_logs_own on public.habit_logs;
create policy habit_logs_own on public.habit_logs for all to authenticated
  using (
    user_id = (select auth.uid())
    and exists (select 1 from public.habits h where h.id = habit_logs.habit_id and h.user_id = (select auth.uid()))
  )
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.habits h where h.id = habit_logs.habit_id and h.user_id = (select auth.uid()))
  );

-- focus_sessions: private; a linked task must be in the same workspace
drop policy if exists focus_sessions_own on public.focus_sessions;
create policy focus_sessions_own on public.focus_sessions for all to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (
    user_id = (select auth.uid())
    and public.is_workspace_member(workspace_id)
    and (task_id is null or exists (
          select 1 from public.tasks t
          where t.id = focus_sessions.task_id and t.workspace_id = focus_sessions.workspace_id))
  );
