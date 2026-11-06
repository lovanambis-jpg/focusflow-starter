/* FocusFlow cloud sync - Stage A: tasks only.
 * Local-first: the UI keeps reading IndexedDB. While signed in, this file mirrors tasks to and from the
 * user's "Personal" workspace in Supabase. Nothing here runs when signed out or offline.
 * Conflict rule: last write wins. An unsynced local edit (device clock) beats a server row (server
 * updated_at) only when it is newer; otherwise the server row replaces the local one.
 * Field mapping: done <-> status (done|todo), due "YYYY-MM-DD" <-> due_at (stored as UTC midnight).
 * Habits: check-ins are merged three ways (local, server, last-synced copy) so two devices never erase each
 * other's check-ins; removing a check-in deletes its row. Needs migration 0004 (habits.updated_at).
 * Focus sessions are append-only: new ones are inserted, nothing is edited or deleted.
 */
(function () {
  "use strict";
  const PAGE = 500, CHUNK = 100, LOGPAGE = 1000, DATE_RE = /^\d{4}-\d{2}-\d{2}$/, PRIORITIES = ["low", "medium", "high"];
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

  // ---- habits + check-ins ----
  async function upsertChunks(client, table, rows, opts) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await client.from(table).upsert(rows.slice(i, i + CHUNK), opts);
      if (error) throw error;
    }
  }
  const habitRow = (h, workspaceId, uid) => ({
    id: h.id, workspace_id: workspaceId, user_id: uid,
    title: String(h.title || "").trim() || "(untitled)",
    created_at: new Date(h.createdAt || Date.now()).toISOString(), archived_at: null
  });
  async function fetchLogs(client, ids) {
    const map = new Map(ids.map((id) => [id, []]));
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      for (let from = 0; ; from += LOGPAGE) {
        const { data, error } = await client.from("habit_logs").select("habit_id,completed_on").in("habit_id", part)
          .order("habit_id", { ascending: true }).order("completed_on", { ascending: true }).range(from, from + LOGPAGE - 1);
        if (error) throw error;
        data.forEach((r) => map.get(r.habit_id).push(String(r.completed_on).slice(0, 10)));
        if (data.length < LOGPAGE) break;
      }
    }
    return map;
  }
  async function pullHabits(client, workspaceId, uid, bm) {
    let max = bm.hCursor;
    for (let from = 0; ; from += PAGE) {
      let q = client.from("habits").select("*").eq("workspace_id", workspaceId).eq("user_id", uid);
      if (bm.hCursor) q = q.gte("updated_at", bm.hCursor);
      const { data, error } = await q.order("updated_at", { ascending: true }).order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data.length) break;
      const logs = await fetchLogs(client, data.map((r) => r.id));
      await FocusDB.syncApplyHabits(data.map((r) => ({
        id: r.id, deleted: !!r.archived_at, title: r.title, createdAt: Date.parse(r.created_at) || Date.now(), logs: logs.get(r.id)
      })));
      data.forEach((r) => { if (!max || r.updated_at > max) max = r.updated_at; });
      if (data.length < PAGE) break;
    }
    if (max !== bm.hCursor) { bm.hCursor = max; await FocusDB.syncSetCursorsB({ ...bm }); }
  }
  async function pushHabits(client, workspaceId, uid) {
    const dirty = await FocusDB.syncDirtyHabits();
    if (!dirty.length) return;
    const live = dirty.filter((h) => !h.deletedAt), dead = dirty.filter((h) => h.deletedAt);
    await upsertChunks(client, "habits", live.map((h) => habitRow(h, workspaceId, uid)), { onConflict: "id" }); // parent rows first
    const touched = [], addRows = [];
    for (const h of live) {
      const L = (h.logs || []).filter((d) => DATE_RE.test(d)), B = h.base || [];
      const adds = L.filter((d) => !B.includes(d)), rems = B.filter((d) => !L.includes(d));
      adds.forEach((d) => addRows.push({ habit_id: h.id, user_id: uid, completed_on: d }));
      if (rems.length) {
        const { error } = await client.from("habit_logs").delete().eq("habit_id", h.id).in("completed_on", rems);
        if (error) throw error;
      }
      if (adds.length || rems.length) touched.push(h);
    }
    await upsertChunks(client, "habit_logs", addRows, { onConflict: "habit_id,completed_on", ignoreDuplicates: true });
    // Touch the habit AFTER its check-ins are saved, so other devices (which pull by habits.updated_at) never miss them.
    if (touched.length) await upsertChunks(client, "habits", touched.map((h) => habitRow(h, workspaceId, uid)), { onConflict: "id" });
    for (let i = 0; i < dead.length; i += CHUNK) {
      const { error } = await client.from("habits").update({ archived_at: new Date().toISOString() }).in("id", dead.slice(i, i + CHUNK).map((h) => h.id));
      if (error) throw error;
    }
    await FocusDB.syncClearDirtyHabits(dirty.map((h) => ({ id: h.id, updatedAt: h.updatedAt, logs: (h.logs || []).filter((d) => DATE_RE.test(d)) })));
  }

  // ---- focus sessions (append-only) ----
  async function pullSessions(client, workspaceId, uid, bm) {
    let max = bm.sCursor;
    for (let from = 0; ; from += PAGE) {
      let q = client.from("focus_sessions").select("*").eq("workspace_id", workspaceId).eq("user_id", uid).eq("mode", "focus");
      if (bm.sCursor) q = q.gte("created_at", bm.sCursor);
      const { data, error } = await q.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data.length) break;
      await FocusDB.syncApplySessions(data.map((r) => {
        const done = r.completed_at || r.created_at;
        return { id: r.id, minutes: r.duration_minutes, completedAt: done, createdAt: Date.parse(done) || Date.now() };
      }));
      data.forEach((r) => { if (!max || r.created_at > max) max = r.created_at; });
      if (data.length < PAGE) break;
    }
    if (max !== bm.sCursor) { bm.sCursor = max; await FocusDB.syncSetCursorsB({ ...bm }); }
  }
  async function pushSessions(client, workspaceId, uid) {
    const dirty = await FocusDB.syncDirtySessions();
    if (!dirty.length) return;
    const rows = dirty.filter((r) => !r.deletedAt).map((r) => ({
      id: r.id, workspace_id: workspaceId, user_id: uid, mode: "focus",
      duration_minutes: Math.max(1, Math.round(Number(r.minutes) || 1)),
      completed_at: (Number.isNaN(Date.parse(r.completedAt)) ? new Date(r.createdAt || Date.now()) : new Date(r.completedAt)).toISOString()
    })); // created_at is left to the server: other devices pull sessions by it
    await upsertChunks(client, "focus_sessions", rows, { onConflict: "id", ignoreDuplicates: true });
    await FocusDB.syncClearDirty(dirty.map((r) => ({ id: r.id, updatedAt: r.updatedAt })), "sessions");
  }

  async function run() {
    if (!ready || FocusDB.mode !== "indexeddb") return;
    const user = FocusAuth.user, client = FocusAuth.client;
    if (!user || !client || !navigator.onLine) return;
    if (running) { again = true; return; }
    running = true; again = false;
    say("● Syncing…");
    const errs = [];
    const step = async (name, fn) => { try { await fn(); } catch (e) { console.warn("Sync failed (" + name + "):", e); errs.push(name); } };
    try {
      const workspaceId = await personalWorkspace(client, user.id);
      let tm = null, bm = null;
      const bindB = async () => bm || (bm = await FocusDB.syncBindB(user.id));
      await step("tasks", async () => { tm = await FocusDB.syncBind(user.id); await pull(client, workspaceId, tm); });
      await step("habits", async () => pullHabits(client, workspaceId, user.id, await bindB()));
      await step("sessions", async () => pullSessions(client, workspaceId, user.id, await bindB()));
      await step("tasks", () => push(client, workspaceId, user.id));
      await step("habits", () => pushHabits(client, workspaceId, user.id));
      await step("sessions", () => pushSessions(client, workspaceId, user.id));
      say(errs.length ? "● Synced with errors (" + [...new Set(errs)].join(", ") + ")" : "● Synced " + clock());
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