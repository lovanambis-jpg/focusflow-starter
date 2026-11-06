// The single place that owns the app state, saving, and re-rendering.
// Features register a render function with onRender(); save() re-renders and persists.
import { $ } from "./utils.js";

export let state = { tasks: [], habits: [], sessions: [], settings: { focus: 25, short: 5, long: 15 } }; // replaced by FocusDB.start() in boot()
export function setState(next) { state = next; }

const renderers = [];
export function onRender(fn) { renderers.push(fn); }
export function render() { renderers.forEach((fn) => fn()); }

export function setStatus(text) { const el = $("#sync-status"); if (el) el.textContent = text; }

export function save() {
  render();
  setStatus("● Saving…");
  FocusDB.save(state)
    .then(() => {
      setStatus(FocusDB.mode === "indexeddb" ? "● Saved on this device" : "● Saved on this device (basic mode)");
      if (window.FocusSync) FocusSync.schedule();
    })
    .catch(() => { setStatus("● Could not save (storage full or blocked)"); });
}