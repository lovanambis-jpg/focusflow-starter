/* FocusFlow cloud sync - Stage A: tasks only.
 * Local-first: the UI keeps reading IndexedDB. While signed in, this file mirrors tasks to and from the
 * user's "Personal" workspace in Supabase. Nothing here runs when signed out or offline.
 * Conflict rule: last write wins. An unsynced local edit (device clock) beats a server row (server
 * updated_at) only when it is newer; otherwise the server row replaces the local one.
 * Field mapping: done <-> status (done|todo), due "YYYY-MM-DD" <-> due_at (stored as UTC midnight).
 * Habits, check-ins and focus sessions are NOT synced yet (they need migration 0004).
 */
(function () {
  "use strict";
  const PAGE = 500, CHUNK = 100, PRIORITIES = ["low", "medium", "high"];
  let ready = false, running = false, again = false, timer = null, ws = null; // ws = {user, id}

  const say = (t) => { const el = document.querySelector("#sync-status"); if (el) el.textContent = t; };
  const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function toRemote(r, workspaceId, uid) {
    return {
      id: r.id, workspace_id: workspaceId, created_by: uid,
      title: String(r.title || "").trim() || "(untitled)",
      priority: PRIORITIES.includes(r.priority) ? r.priority : "medium",
      status: r.done ? "done" : "todo",
      due_at: /^\d{4}-\d{2}-\d{2}$/.test(r.due || "") ? r.due + "T00:00:00Z" : null,
      created_at: new Date(r.createdAt || Date.now()).toISOString(),
      deleted_at: null
    };
  }
  function fromRemote(row) {
    const updatedAt = Date.parse(row.updated_at) || Date.now();
    const createdAt = Date.parse(row.created_at) || updatedAt;
    if (row.deleted_at) return { id: row.id, deleted: true, createdAt, updatedAt };
    return {
      id: row.id, deleted: false, createdAt, updatedAt,
      item: {
        id: row.id, title: row.title,
        priority: PRIORITIES.includes(row.priority) ? row.priority : "medium",
        due: row.due_at ? String(row.due_at).slice(0, 10) : "",
        done: row.status === "done"
      }
    };
  }

  async function personalWorkspace(client, uid) {
    if (ws && ws.user === uid) return ws.id;
    const { data, error } = await client.from("workspaces").select("id").eq("type", "personal").eq("owner_id", uid).limit(1);
    if (error) throw error;
    if (!data || !data.length) throw new Error("Personal workspace not found for this account");
    ws = { user: uid, id: data[0].id };
    return ws.id;
  }

  async function pull(client, workspaceId, meta) {
    let maxSeen = meta.cursor;
    for (let from = 0; ; from += PAGE) {
      let q = client.from("tasks").select("*").eq("workspace_id", workspaceId);
      if (meta.cursor) q = q.gte("updated_at", meta.cursor); // >= so rows sharing the boundary timestamp are never missed
      const { data, error } = await q.order("updated_at", { ascending: true }).order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data.length) break;
      await FocusDB.syncApplyTasks(data.map(fromRemote));
      data.forEach((r) => { if (!maxSeen || r.updated_at > maxSeen) maxSeen = r.updated_at; });
      if (data.length < PAGE) break;
    }
    if (maxSeen !== meta.cursor) await FocusDB.syncSetCursor(meta.user, maxSeen);
  }

  async function push(client, workspaceId, uid) {
    const dirty = await FocusDB.syncDirtyTasks();
    if (!dirty.length) return;
    const live = dirty.filter((r) => !r.deletedAt), dead = dirty.filter((r) => r.deletedAt);
    for (let i = 0; i < live.length; i += CHUNK) {
      const rows = live.slice(i, i + CHUNK).map((r) => toRemote(r, workspaceId, uid));
      const { error } = await client.from("tasks").upsert(rows, { onConflict: "id" });
      if (error) throw error;
    }
    // A deleted task only needs deleted_at set. If it never reached the server, the update simply matches nothing.
    for (let i = 0; i < dead.length; i += CHUNK) {
      const ids = dead.slice(i, i + CHUNK).map((r) => r.id);
      const { error } = await client.from("tasks").update({ deleted_at: new Date().toISOString() }).in("id", ids);
      if (error) throw error;
    }
    await FocusDB.syncClearDirty(dirty.map((r) => ({ id: r.id, updatedAt: r.updatedAt })));
  }

  async function run() {
    if (!ready || FocusDB.mode !== "indexeddb") return;
    const user = FocusAuth.user, client = FocusAuth.client;
    if (!user || !client || !navigator.onLine) return;
    if (running) { again = true; return; }
    running = true; again = false;
    say("● Syncing…");
    try {
      const workspaceId = await personalWorkspace(client, user.id);
      const meta = await FocusDB.syncBind(user.id);
      await pull(client, workspaceId, meta);
      await push(client, workspaceId, user.id);
      say("● Synced " + clock());
    } catch (e) {
      console.warn("Sync failed:", e);
      say("● Sync failed - saved on this device");
    } finally {
      running = false;
      if (again) schedule(1500);
    }
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(run, ms == null ? 2000 : ms); }

  function start() {
    if (ready) return;
    ready = true;
    window.addEventListener("online", () => schedule(500));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") schedule(800); });
    setInterval(() => { if (document.visibilityState === "visible") schedule(0); }, 120000);
    schedule(500);
  }

  FocusAuth.onChange(() => {
    if (!FocusAuth.user) { if (ready && FocusDB.mode === "indexeddb") say("● Saved on this device"); return; }
    schedule(300);
  });

  window.FocusSync = { start, schedule, run };
})();