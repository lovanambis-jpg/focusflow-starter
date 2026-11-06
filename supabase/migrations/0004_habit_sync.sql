-- FocusFlow 0004: support syncing habits (apply after 0003).
-- Adds habits.updated_at so a device can pull only the habits that changed. Nothing else changes.

alter table public.habits add column if not exists updated_at timestamptz not null default now();

drop trigger if exists trg_habits_touch on public.habits;
create trigger trg_habits_touch before update on public.habits
  for each row execute function public.touch_updated_at();

create index if not exists habits_workspace_updated_idx on public.habits (workspace_id, updated_at);
create index if not exists focus_sessions_workspace_created_idx on public.focus_sessions (workspace_id, created_at);