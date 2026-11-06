// Small helpers shared by every part of the app. No state, no side effects.
export const $ = (s) => document.querySelector(s);
export const $$ = (s) => [...document.querySelectorAll(s)];
export const dayStr = (off=0) => { const d=new Date(); d.setDate(d.getDate()+off); return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,10); };
export const today = () => dayStr(0);
export const streak = (logs) => { const s=new Set(logs||[]); let off=s.has(dayStr(0))?0:-1, n=0; while(s.has(dayStr(off))){n++;off--;} return n; };
export const id = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random());
export const toast = (msg) => { const el=$("#toast"); el.textContent=msg; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2200); };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));