const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const dayStr = (off=0) => { const d=new Date(); d.setDate(d.getDate()+off); return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,10); };
const today = () => dayStr(0);
const streak = (logs) => { const s=new Set(logs||[]); let off=s.has(dayStr(0))?0:-1, n=0; while(s.has(dayStr(off))){n++;off--;} return n; };
let state = {tasks:[],habits:[],sessions:[],settings:{focus:25,short:5,long:15}}; // replaced by FocusDB.start() in boot()
let filter = "all";
let greetName = "NANDRA", currentView = "dashboard";
let mode = "focus", remaining = state.settings.focus*60, interval = null, running = false, endAt = null, planned = state.settings.focus;
const save = () => { render(); $("#sync-status").textContent = "● Saving…"; FocusDB.save(state).then(()=>{ $("#sync-status").textContent = FocusDB.mode==="indexeddb" ? "● Saved on this device" : "● Saved on this device (basic mode)"; if(window.FocusSync) FocusSync.schedule(); }).catch(()=>{ $("#sync-status").textContent = "● Could not save (storage full or blocked)"; }); };
const id = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random());
const toast = (msg) => { const el=$("#toast"); el.textContent=msg; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2200); };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function setView(name){currentView=name;$$(".view").forEach(v=>v.classList.toggle("active",v.id===`view-${name}`));$$("[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===name));$("#page-title").textContent=({dashboard:"Good day, "+greetName+" 👋",tasks:"My Tasks",focus:"Focus Timer",habits:"Habit Tracker"})[name]||"FocusFlow";window.scrollTo(0,0);}
$$("[data-view]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
$$("[data-go]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.go)));
function taskMarkup(t){return `<div class="task-row ${t.done?"completed":""}"><input class="task-check" type="checkbox" data-complete="${t.id}" ${t.done?"checked":""}><div class="task-main"><b>${escapeHtml(t.title)}</b><small>${t.due?`Due ${t.due}`:"No deadline"}</small></div><span class="priority ${t.priority}">${t.priority}</span><div class="row-actions"><button title="Edit" data-edit="${t.id}">✎</button><button title="Delete" data-delete="${t.id}">×</button></div></div>`}
function renderTasks(){const list=state.tasks.filter(t=>filter==="all"||(filter==="open"&&!t.done)||(filter==="done"&&t.done));$("#task-list").innerHTML=list.length?list.map(taskMarkup).join(""):'<div class="empty-state">No tasks here yet. Add your first task ✨</div>';const todayTasks=state.tasks.filter(t=>!t.done).slice(0,4);$("#dashboard-tasks").innerHTML=todayTasks.length?todayTasks.map(taskMarkup).join(""):'<div class="empty-state">Your space is clear. Add a task to get started.</div>';$$("[data-complete]").forEach(el=>el.addEventListener("change",()=>{const t=state.tasks.find(x=>x.id===el.dataset.complete);if(t)t.done=el.checked;save();}));$$("[data-delete]").forEach(el=>el.addEventListener("click",()=>{state.tasks=state.tasks.filter(x=>x.id!==el.dataset.delete);save();toast("Task deleted");}));$$("[data-edit]").forEach(el=>el.addEventListener("click",()=>openTask(el.dataset.edit)));}
function renderHabits(){const day=today();$("#habit-list").innerHTML=state.habits.length?state.habits.map(h=>{const done=(h.logs||[]).includes(day);return `<div class="habit-row"><div class="habit-emoji">✳</div><div class="habit-info"><b>${escapeHtml(h.title)}</b><small>${streak(h.logs)}-day streak · ${(h.logs||[]).length} check-ins · ${done?"Completed today":"Keep your streak going"}</small></div><button data-habit="${h.id}">${done?"✓ Done":"Check in"}</button></div>`}).join(""):'<div class="empty-state">No habits yet. Start with one small routine.</div>';$$("[data-habit]").forEach(b=>b.addEventListener("click",()=>{const h=state.habits.find(x=>x.id===b.dataset.habit);if(!h.logs)h.logs=[];const d=today();h.logs=h.logs.includes(d)?h.logs.filter(x=>x!==d):[...h.logs,d];save();}));}
function render(){renderTasks();renderHabits();$("#stat-completed").textContent=state.tasks.filter(t=>t.done).length;$("#stat-focus").textContent=state.sessions.reduce((a,s)=>a+s.minutes,0);$("#stat-habits").textContent=state.habits.length;$("#session-count").textContent=state.sessions.length;$("#focus-total").textContent=state.sessions.reduce((a,s)=>a+s.minutes,0)+" min";}
function openTask(taskId){const t=state.tasks.find(x=>x.id===taskId);$("#task-dialog-title").textContent=t?"Edit task":"Create a task";$("#task-id").value=t?.id||"";$("#task-title").value=t?.title||"";$("#task-priority").value=t?.priority||"medium";$("#task-due").value=t?.due||"";$("#task-dialog").showModal();}
$("#new-task-btn").addEventListener("click",()=>openTask());$("#task-form").addEventListener("submit",e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();const task={id:$("#task-id").value||id(),title:$("#task-title").value.trim(),priority:$("#task-priority").value,due:$("#task-due").value};if(!task.title)return;const idx=state.tasks.findIndex(t=>t.id===task.id);if(idx>=0)state.tasks[idx]={...state.tasks[idx],...task};else state.tasks.unshift({...task,done:false});$("#task-dialog").close();save();toast("Task saved");});
$("#new-habit-btn").addEventListener("click",()=>$("#habit-dialog").showModal());$("#habit-form").addEventListener("submit",e=>{if(e.submitter?.value==="cancel")return;e.preventDefault();const title=$("#habit-title").value.trim();if(!title)return;state.habits.push({id:id(),title,logs:[]});$("#habit-dialog").close();$("#habit-title").value="";save();toast("Habit added");});
$$("[data-filter]").forEach(b=>b.addEventListener("click",()=>{filter=b.dataset.filter;$$("[data-filter]").forEach(x=>x.classList.toggle("active",x===b));renderTasks();}));
function durations(){return {focus:Math.max(1,Math.min(90,Number($("#focus-length").value)||25)),short:Math.max(1,Math.min(30,Number($("#short-length").value)||5)),long:Math.max(1,Math.min(60,Number($("#long-length").value)||15))};}
function displayTimer(){const m=Math.floor(remaining/60),s=remaining%60;const str=`${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;$("#timer-display").textContent=str;$("#mini-timer").textContent=str;const total=durations()[mode]*60;const deg=(1-remaining/total)*360;$(".timer-ring").style.background=`conic-gradient(#7665e4 ${deg}deg,#e9e6fb ${deg}deg)`;}
function selectMode(next){pauseTimer();mode=next;planned=durations()[mode];remaining=planned*60;$$("[data-mode]").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));$("#timer-caption").textContent=mode==="focus"?"TIME TO FOCUS":mode==="short"?"SHORT BREAK":"LONG BREAK";$("#timer-start").textContent="Start "+(mode==="focus"?"focus":"break");$("#timer-message").textContent="";displayTimer();}
function startLabel(){return "Start "+(mode==="focus"?"focus":"break");}
function pauseTimer(){if(interval)clearInterval(interval);interval=null;if(running&&endAt)remaining=Math.max(0,Math.ceil((endAt-Date.now())/1000));running=false;endAt=null;$("#timer-start").textContent=(remaining>0&&remaining<planned*60)?"Resume":startLabel();}
function tick(){remaining=Math.max(0,Math.ceil((endAt-Date.now())/1000));displayTimer();if(remaining<=0)finishTimer();}
function finishTimer(){const finished=mode;pauseTimer();remaining=planned*60;$("#timer-start").textContent=startLabel();displayTimer();if(finished==="focus"){state.sessions.push({id:id(),minutes:planned,completedAt:new Date().toISOString()});save();toast("Focus session complete. Great work!");$("#timer-message").textContent="Well done. Take a mindful break.";}else toast("Break finished. Ready for another round?");}
$$("[data-mode]").forEach(b=>b.addEventListener("click",()=>selectMode(b.dataset.mode)));
$("#timer-start").addEventListener("click",()=>{if(running){pauseTimer();return;}running=true;endAt=Date.now()+remaining*1000;$("#timer-start").textContent="Pause";interval=setInterval(tick,250);});
$("#timer-reset").addEventListener("click",()=>selectMode(mode));
["focus","short","long"].forEach(k=>$("#"+k+"-length").addEventListener("change",()=>{state.settings=durations();save();selectMode(mode);}));
$("#today-label").textContent=new Date().toLocaleDateString("id-ID",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).toUpperCase();
if("serviceWorker" in navigator && location.protocol!=="file:"){navigator.serviceWorker.register("./service-worker.js").catch(()=>{});}
window.addEventListener("online",()=>{$("#sync-status").textContent="● Online · local data saved";});window.addEventListener("offline",()=>{$("#sync-status").textContent="● Offline · local mode";});
async function boot(){
  try { const res = await FocusDB.start(); state = res.state; if(res.migrated) toast("Existing data moved to IndexedDB"); }
  catch(e){ console.error(e); }
  ["focus","short","long"].forEach(k=>{$("#"+k+"-length").value=state.settings[k];});
  remaining=durations()[mode]*60; planned=durations()[mode];
  $("#sync-status").textContent = FocusDB.mode==="indexeddb" ? "● Saved on this device" : "● Saved on this device (basic mode)";
  render(); displayTimer();
  FocusDB.onTasksReplaced = (tasks) => { state.tasks = tasks; render(); };
  if(window.FocusSync) FocusSync.start();
}
boot();

// ---- Account (Google sign-in) ----
function setAvatar(el, url, initial){
  el.textContent = "";
  if(url){ const img=document.createElement("img"); img.src=url; img.alt=""; img.referrerPolicy="no-referrer"; img.onerror=()=>{ el.textContent=initial; }; el.appendChild(img); }
  else el.textContent = initial;
}
function renderAccount(){
  const st = FocusAuth.status, p = FocusAuth.profile();
  const label = p ? (p.name || p.email) : "";
  const initial = (label.trim().charAt(0) || "N").toUpperCase();
  ["#account-btn","#side-avatar","#dialog-avatar"].forEach(sel=>setAvatar($(sel), p && p.avatar, initial));
  $("#side-name").textContent = p ? label : "My Workspace";
  $("#side-sub").textContent = p ? "Signed in with Google" : "Local mode";
  greetName = (p && p.name.split(" ")[0]) || "Nandra";
  if(currentView==="dashboard") $("#page-title").textContent = "Good Day, "+greetName+" 👋";
  $("#account-out").hidden = !!p; $("#account-in").hidden = !p;
  $("#account-name").textContent = p ? (p.name || p.email) : ""; $("#account-email").textContent = p ? p.email : "";
  const btn = $("#google-signin");
  btn.disabled = st!=="ready";
  $("#account-hint").textContent = ({
    unconfigured:({missing:"assets/config.js did not load (FOCUSFLOW_CONFIG is undefined). Reload; if it persists, unregister the service worker.",empty:"Cloud login is not set up yet. Add your Supabase URL and key in assets/config.js.",no_url:"supabaseUrl is empty in assets/config.js.",no_key:"supabaseKey is empty in assets/config.js.",bad_url:"supabaseUrl in assets/config.js is not a valid https URL.",secret_key:"That is a secret key. Use the publishable (or anon) key in assets/config.js, never a secret key."})[FocusAuth.reason]||"Cloud login is not set up yet. Add your Supabase URL and key in assets/config.js.",
    loading:"Connecting to the login service…",
    unavailable:"Could not reach the login service. Check your connection and reload.",
    ready:""
  })[st] || "";
}
$$("[data-account]").forEach(el=>{
  el.addEventListener("click",()=>{ renderAccount(); $("#account-dialog").showModal(); });
  el.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); el.click(); } });
});
$("#account-close").addEventListener("click",()=>$("#account-dialog").close());
$("#google-signin").addEventListener("click",async()=>{
  const btn=$("#google-signin"); btn.disabled=true; btn.textContent="Redirecting to Google…";
  try{ await FocusAuth.signInWithGoogle(); }
  catch(e){ console.error(e); toast("Could not start Google sign-in"); btn.textContent="Continue with Google"; renderAccount(); }
});
$("#signout-btn").addEventListener("click",async()=>{
  try{ await FocusAuth.signOut(); $("#account-dialog").close(); toast("Signed out. Your data stays on this device."); }
  catch(e){ console.error(e); toast("Could not sign out"); }
});
FocusAuth.onChange(renderAccount);
FocusAuth.init();
