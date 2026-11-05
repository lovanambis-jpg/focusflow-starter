/* FocusFlow storage layer.
 * - IndexedDB is the primary store (stores: tasks, habits, sessions, meta).
 * - Every record carries createdAt / updatedAt / deletedAt so it can be synced to Supabase later.
 * - Deleting a record leaves a tombstone (id + deletedAt only) instead of removing it.
 * - Falls back to localStorage when IndexedDB is unavailable (e.g. some private modes).
 * - On first run, data from the old localStorage key "focusflow-v1" is imported once.
 *   The old key is left untouched as a backup.
 */
(function () {
  "use strict";
  const DB_NAME = "focusflow", DB_VERSION = 1;
  const STORES = ["tasks", "habits", "sessions"];
  const LEGACY_KEY = "focusflow-v1";
  const DEFAULT_SETTINGS = () => ({ focus: 25, short: 5, long: 15 });
  const emptyState = () => ({ tasks: [], habits: [], sessions: [], settings: DEFAULT_SETTINGS() });

  let mode = "indexeddb";
  let dbPromise = null;
  let snap = null;          // per store: Map(id -> {json, createdAt, tomb})
  let settingsJson = null;  // last persisted settings JSON
  let chain = Promise.resolve();

  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error("Transaction aborted")); });
  const freshSnap = () => ({ tasks: new Map(), habits: new Map(), sessions: new Map() });

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB not supported"));
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach((n) => { if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: "id" }); });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
    return dbPromise;
  }

  // ---- legacy localStorage helpers -------------------------------------------------
  function sanitize(s) {
    const d = emptyState();
    if (!s || typeof s !== "object") return d;
    const arr = (x) => (Array.isArray(x) ? x.filter((i) => i && typeof i === "object" && i.id) : []);
    return {
      tasks: arr(s.tasks), habits: arr(s.habits), sessions: arr(s.sessions),
      settings: { ...d.settings, ...(s.settings && typeof s.settings === "object" ? s.settings : {}) }
    };
  }
  function readLegacy() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      return sanitize(JSON.parse(raw));
    } catch (e) { console.warn("Could not read saved data.", e); return null; }
  }
  const hasData = (s) => s.tasks.length || s.habits.length || s.sessions.length;

  // ---- IndexedDB load / save -------------------------------------------------------
  async function loadFromIdb() {
    const db = await openDb();
    const t = db.transaction([...STORES, "meta"], "readonly");
    const reqs = STORES.map((n) => reqP(t.objectStore(n).getAll()));
    const settingsReq = reqP(t.objectStore("meta").get("settings"));
    const [tasks, habits, sessions] = await Promise.all(reqs);
    const settingsRec = await settingsReq;
    snap = freshSnap();
    const state = emptyState();
    const byName = { tasks, habits, sessions };
    STORES.forEach((name) => {
      const live = [];
      byName[name].forEach((rec) => {
        if (rec.deletedAt) { snap[name].set(rec.id, { json: null, createdAt: rec.createdAt || 0, tomb: true }); return; }
        const { createdAt, updatedAt, deletedAt, _d, ...item } = rec;
        snap[name].set(item.id, { json: JSON.stringify(item), createdAt: createdAt || 0, tomb: false });
        live.push({ item, createdAt: createdAt || 0 });
      });
      state[name] = live;
    });
    // preserve the order the UI expects: newest task first, habits and sessions oldest first
    state.tasks.sort((a, b) => b.createdAt - a.createdAt || (a.item.id < b.item.id ? 1 : -1));
    state.habits.sort((a, b) => a.createdAt - b.createdAt || (a.item.id < b.item.id ? -1 : 1));
    state.sessions.sort((a, b) => a.createdAt - b.createdAt || (a.item.id < b.item.id ? -1 : 1));
    STORES.forEach((n) => { state[n] = state[n].map((x) => x.item); });
    if (settingsRec && settingsRec.value && typeof settingsRec.value === "object") {
      state.settings = { ...state.settings, ...settingsRec.value };
      settingsJson = JSON.stringify(settingsRec.value);
    } else { settingsJson = null; }
    return state;
  }

  async function saveToIdb(state) {
    const db = await openDb();
    const now = Date.now();
    const t = db.transaction([...STORES, "meta"], "readwrite");
    const pending = [];
    STORES.forEach((name) => {
      const os = t.objectStore(name);
      const seen = new Set();
      (state[name] || []).forEach((item) => {
        seen.add(item.id);
        const json = JSON.stringify(item);
        const cur = snap[name].get(item.id);
        if (cur && !cur.tomb && cur.json === json) return;
        const createdAt = (cur && cur.createdAt) || now;
        os.put({ ...item, createdAt, updatedAt: now, deletedAt: null, _d: 1 });
        pending.push([name, item.id, { json, createdAt, tomb: false }]);
      });
      snap[name].forEach((cur, id) => {
        if (seen.has(id) || cur.tomb) return;
        os.put({ id, createdAt: cur.createdAt, updatedAt: now, deletedAt: now, _d: 1 });
        pending.push([name, id, { json: null, createdAt: cur.createdAt, tomb: true }]);
      });
    });
    const sJson = JSON.stringify(state.settings || DEFAULT_SETTINGS());
    if (sJson !== settingsJson) t.objectStore("meta").put({ key: "settings", value: JSON.parse(sJson), updatedAt: now });
    await txDone(t);
    pending.forEach(([name, id, entry]) => snap[name].set(id, entry));
    settingsJson = sJson;
  }

  // ---- public API ------------------------------------------------------------------
  /** Opens storage and returns {state, mode, migrated}. */
  async function start() {
    try {
      await openDb();
      mode = "indexeddb";
      let state = await loadFromIdb();
      let migrated = false;
      const imported = await getMeta("legacyImported");
      if (!imported) {
        const old = readLegacy();
        if (old && hasData(old) && !hasData(state)) {
          const base = Date.now();
          // legacy ordering is preserved by seeding createdAt in saveInOrder
          state = old;
          await saveInOrder(state, base);
          migrated = true;
        }
        await setMeta("legacyImported", true);
      }
      if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(() => {}); }
      return { state, mode, migrated };
    } catch (e) {
      console.warn("IndexedDB unavailable, using localStorage.", e);
      mode = "localstorage";
      const state = readLegacy() || emptyState();
      return { state, mode, migrated: false };
    }
  }

  // Seed createdAt so that legacy order survives: tasks newest-first, habits/sessions oldest-first.
  async function saveInOrder(state, base) {
    const db = await openDb();
    const t = db.transaction([...STORES, "meta"], "readwrite");
    snap = snap || freshSnap();
    const pending = [];
    const stamp = (name, items, ts) => items.forEach((item, i) => {
      const createdAt = ts(i);
      t.objectStore(name).put({ ...item, createdAt, updatedAt: base, deletedAt: null });
      pending.push([name, item.id, { json: JSON.stringify(item), createdAt, tomb: false }]);
    });
    stamp("tasks", state.tasks, (i) => base - i);
    stamp("habits", state.habits, (i) => base + i);
    stamp("sessions", state.sessions, (i) => base + i);
    const sJson = JSON.stringify(state.settings);
    t.objectStore("meta").put({ key: "settings", value: state.settings, updatedAt: base });
    await txDone(t);
    pending.forEach(([name, id, entry]) => snap[name].set(id, entry));
    settingsJson = sJson;
  }

  async function getMeta(key) {
    const db = await openDb();
    const rec = await reqP(db.transaction("meta", "readonly").objectStore("meta").get(key));
    return rec ? rec.value : undefined;
  }
  async function setMeta(key, value) {
    const db = await openDb();
    const t = db.transaction("meta", "readwrite");
    t.objectStore("meta").put({ key, value, updatedAt: Date.now() });
    await txDone(t);
  }

  /** Persists the whole state (only changed records are written). Calls are queued in order. */
  function save(state) {
    const run = () => {
      const copy = JSON.parse(JSON.stringify(state)); // copied when it runs, so it always sees the latest in-memory state
      if (mode === "localstorage") {
        return new Promise((res, rej) => { try { localStorage.setItem(LEGACY_KEY, JSON.stringify(copy)); res(); } catch (e) { rej(e); } });
      }
      return saveToIdb(copy);
    };
    const p = chain.then(run);
    chain = p.catch(() => {});
    return p;
  }

  // ---- sync helpers (tasks only; used by assets/sync.js) -----------------------------
  // Records that still need uploading carry _d:1. Bookkeeping {user, cursor} lives in meta key "sync".
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const newUuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
  const taskKey = (r) => JSON.stringify([r.title, r.priority, r.due, r.done, r.deletedAt ? 1 : 0]);
  let onTasksReplaced = null;
  const queued = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  async function allTaskRecs() {
    const db = await openDb();
    return reqP(db.transaction("tasks", "readonly").objectStore("tasks").getAll());
  }
  // Reloads IndexedDB into memory (also refreshes the diff snapshot) and hands the tasks to the UI.
  async function refreshTasks() { const st = await loadFromIdb(); if (onTasksReplaced) onTasksReplaced(st.tasks); }

  /** First sync for this account on this device: mark every local task as "needs upload". Returns {user, cursor}. */
  function syncBind(userId) {
    return queued(async () => {
      const cur = await getMeta("sync");
      if (cur && cur.user === userId) return cur;
      const recs = await allTaskRecs();
      const db = await openDb();
      const t = db.transaction(["tasks", "meta"], "readwrite");
      recs.forEach((r) => t.objectStore("tasks").put({ ...r, _d: 1 }));
      const value = { user: userId, cursor: null };
      t.objectStore("meta").put({ key: "sync", value, updatedAt: Date.now() });
      await txDone(t);
      return value;
    });
  }
  function syncSetCursor(userId, cursor) {
    return queued(() => setMeta("sync", { user: userId, cursor }));
  }
  /** incoming: [{id, deleted, createdAt, updatedAt, item?}] from the server. Unsynced local edits that are newer win. */
  function syncApplyTasks(incoming) {
    return queued(async () => {
      const local = new Map((await allTaskRecs()).map((r) => [r.id, r]));
      const db = await openDb();
      const t = db.transaction("tasks", "readwrite");
      const os = t.objectStore("tasks");
      let changed = 0;
      incoming.forEach((n) => {
        const cur = local.get(n.id);
        if (cur && cur._d && cur.updatedAt > n.updatedAt) return;
        if (n.deleted && (!cur || cur.deletedAt)) return;
        const createdAt = (cur && cur.createdAt) || n.createdAt;
        const rec = n.deleted
          ? { id: n.id, createdAt, updatedAt: n.updatedAt, deletedAt: n.updatedAt }
          : { ...n.item, createdAt, updatedAt: n.updatedAt, deletedAt: null };
        if (cur && !cur._d && taskKey(cur) === taskKey(rec)) return;
        os.put(rec);
        changed++;
      });
      await txDone(t);
      if (changed) await refreshTasks();
      return changed;
    });
  }
  /** Returns raw task records waiting for upload. Non-UUID ids (very old data) get a new UUID first. */
  function syncDirtyTasks() {
    return queued(async () => {
      let dirty = (await allTaskRecs()).filter((r) => r._d);
      const bad = dirty.filter((r) => !UUID_RE.test(r.id));
      if (bad.length) {
        const db = await openDb();
        const t = db.transaction("tasks", "readwrite");
        bad.forEach((r) => { t.objectStore("tasks").delete(r.id); if (!r.deletedAt) t.objectStore("tasks").put({ ...r, id: newUuid() }); });
        await txDone(t);
        await refreshTasks();
        dirty = (await allTaskRecs()).filter((r) => r._d);
      }
      return dirty;
    });
  }
  /** list: [{id, updatedAt}] that were uploaded. A record edited meanwhile (different updatedAt) stays dirty. */
  function syncClearDirty(list) {
    return queued(async () => {
      const recs = new Map((await allTaskRecs()).map((r) => [r.id, r]));
      const db = await openDb();
      const t = db.transaction("tasks", "readwrite");
      list.forEach(({ id, updatedAt }) => {
        const r = recs.get(id);
        if (r && r._d && r.updatedAt === updatedAt) { const { _d, ...rest } = r; t.objectStore("tasks").put(rest); }
      });
      await txDone(t);
    });
  }

  window.FocusDB = {
    start, save, get mode() { return mode; },
    set onTasksReplaced(fn) { onTasksReplaced = fn; },
    syncBind, syncSetCursor, syncApplyTasks, syncDirtyTasks, syncClearDirty
  };
})();