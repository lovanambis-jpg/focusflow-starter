-- FocusFlow foundation helpers (apply after 0001). RLS policies still come with the auth/workspace milestone.

-- 1) Keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_workspaces_touch on public.workspaces;
create trigger trg_workspaces_touch before update on public.workspaces
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_tasks_touch on public.tasks;
create trigger trg_tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();

-- 2) On sign-up: create profile + personal workspace + owner membership
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_workspace_id uuid;
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)));

  insert into public.workspaces (name, type, owner_id)
  values ('Personal', 'personal', new.id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) Indexes for the queries the app will run most
create index if not exists idx_workspace_members_user on public.workspace_members (user_id);
create index if not exists idx_tasks_workspace_status on public.tasks (workspace_id, status) where deleted_at is null;
create index if not exists idx_tasks_assigned_to on public.tasks (assigned_to) where deleted_at is null;
create index if not exists idx_tasks_due_at on public.tasks (due_at) where deleted_at is null;
create index if not exists idx_habits_user on public.habits (user_id) where archived_at is null;
create index if not exists idx_habit_logs_user_day on public.habit_logs (user_id, completed_on);
create index if not exists idx_focus_sessions_user_created on public.focus_sessions (user_id, created_at desc);
