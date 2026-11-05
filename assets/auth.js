/* FocusFlow auth layer (Supabase Auth, Google sign-in only).
 * Local-first: the app works fully without signing in. If the config is empty or the
 * SDK cannot be loaded (offline), status becomes "unconfigured" / "unavailable" and nothing breaks.
 */
(function () {
  "use strict";
  // Pinned version, loaded on demand so that offline use is never blocked by it.
  const SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  const listeners = new Set();
  let client = null, user = null, status = "unconfigured"; // unconfigured | loading | ready | unavailable

  let reason = ""; // why status is "unconfigured": missing | empty | no_url | no_key | bad_url | secret_key

  function isSecretKey(k) {
    if (/^sb_secret_/i.test(k)) return true;
    const parts = k.split(".");
    if (parts.length === 3) {
      try { return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "service_role"; } catch (e) { /* not a JWT */ }
    }
    return false;
  }
  function keyKind(k) {
    if (!k) return "none";
    if (/^sb_publishable_/i.test(k)) return "publishable";
    if (isSecretKey(k)) return "SECRET (do not use in the browser)";
    return k.split(".").length === 3 ? "legacy-jwt (anon?)" : "unknown";
  }
  // Reads window.FOCUSFLOW_CONFIG. The URL is reduced to its origin, so a pasted
  // ".../rest/v1/" or ".../auth/v1" suffix, spaces or a trailing slash do not break sign-in.
  function readConfig() {
    const c = window.FOCUSFLOW_CONFIG;
    if (!c || typeof c !== "object") return { ok: false, reason: "missing" };
    const url = String(c.supabaseUrl || "").trim(), key = String(c.supabaseKey || "").trim();
    if (!url && !key) return { ok: false, reason: "empty" };
    if (!url) return { ok: false, reason: "no_url" };
    if (!key) return { ok: false, reason: "no_key" };
    let u;
    try { u = new URL(url); } catch (e) { return { ok: false, reason: "bad_url" }; }
    if (!(u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1")) return { ok: false, reason: "bad_url" };
    if (isSecretKey(key)) return { ok: false, reason: "secret_key" };
    return { ok: true, url: u.origin, key, trimmedPath: u.pathname.replace(/\/+$/, "") !== "" };
  }
  function emit() { listeners.forEach((fn) => { try { fn({ status, user }); } catch (e) { console.error(e); } }); }
  function setStatus(s) { status = s; emit(); }

  function loadSdk() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      const timer = setTimeout(() => { el.remove(); reject(new Error("Supabase SDK timed out")); }, 10000);
      el.src = SDK_URL; el.async = true; el.crossOrigin = "anonymous";
      el.onload = () => { clearTimeout(timer); window.supabase && window.supabase.createClient ? resolve() : reject(new Error("Supabase SDK missing")); };
      el.onerror = () => { clearTimeout(timer); reject(new Error("Could not load Supabase SDK")); };
      document.head.appendChild(el);
    });
  }

  async function init() {
    const conf = readConfig();
    if (!conf.ok) { reason = conf.reason; setStatus("unconfigured"); return; }
    reason = "";
    if (conf.trimmedPath) console.warn("supabaseUrl contained a path; using only", conf.url);
    setStatus("loading");
    try {
      await loadSdk();
      client = window.supabase.createClient(conf.url, conf.key, {
        auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const { data } = await client.auth.getSession();
      user = (data && data.session && data.session.user) || null;
      // Keep this callback synchronous: calling other Supabase methods inside it can deadlock.
      client.auth.onAuthStateChange((_event, session) => { user = (session && session.user) || null; emit(); });
      setStatus("ready");
    } catch (e) {
      console.warn("Cloud login unavailable:", e);
      client = null; user = null;
      setStatus("unavailable");
    }
  }

  async function signInWithGoogle() {
    if (!client) throw new Error("Cloud login is not available");
    // Must be listed under Authentication -> URL Configuration -> Redirect URLs in Supabase.
    const redirectTo = location.origin + location.pathname;
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo, queryParams: { prompt: "select_account" } }
    });
    if (error) throw error;
  }

  async function signOut() {
    if (!client) return;
    const { error } = await client.auth.signOut({ scope: "local" }); // this device only; local data is kept
    if (error) throw error;
  }

  function profile() {
    if (!user) return null;
    const m = user.user_metadata || {};
    const avatar = String(m.avatar_url || m.picture || "");
    return {
      id: user.id,
      email: user.email || "",
      name: String(m.full_name || m.name || "").trim(),
      avatar: /^https:\/\//i.test(avatar) ? avatar : ""
    };
  }

  /** Safe to paste in a bug report: never returns the key itself. Run FocusAuth.diagnose() in the console. */
  function diagnose() {
    const c = window.FOCUSFLOW_CONFIG, hasObj = !!c && typeof c === "object";
    let host = null, hadPath = false;
    try { const u = new URL(String(hasObj ? c.supabaseUrl : "").trim()); host = u.host; hadPath = u.pathname.replace(/\/+$/, "") !== ""; } catch (e) { /* no url */ }
    const key = hasObj ? String(c.supabaseKey || "").trim() : "";
    return {
      status, reason: reason || null, configObject: hasObj ? "loaded" : "UNDEFINED (config.js did not load)",
      supabaseHost: host, urlHadExtraPath: hadPath, keyKind: keyKind(key), keyLength: key.length,
      sdkLoaded: !!(window.supabase && window.supabase.createClient), signedIn: !!user,
      page: location.origin + location.pathname,
      serviceWorkerControlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller)
    };
  }

  window.FocusAuth = {
    init, signInWithGoogle, signOut, profile, diagnose,
    get reason() { return reason; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get user() { return user; },
    get client() { return client; },
    get status() { return status; }
  };
})();
