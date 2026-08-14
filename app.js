/* ==========================================================================
   Rinix Mail — Application Logic
   Vanilla JS ES6+. No bundler, no framework. Loaded with `defer`.
   ==========================================================================
   FIREBASE SETUP REQUIRED:
   Fill in the config object below with your Firebase project's credentials
   (Project Settings -> General -> Your apps -> SDK setup). Until real
   credentials are provided, the app runs fully in DEMO MODE so the UI,
   handle-lock UX, inbox, composer and API-key flows can all be exercised
   without a backend.
   ========================================================================== */

const FIREBASE_CONFIG = {
  apiKey: "REPLACE_WITH_FIREBASE_API_KEY",
  authDomain: "REPLACE_WITH_PROJECT.firebaseapp.com",
  projectId: "REPLACE_WITH_PROJECT_ID",
  storageBucket: "REPLACE_WITH_PROJECT.appspot.com",
  messagingSenderId: "REPLACE_WITH_SENDER_ID",
  appId: "REPLACE_WITH_APP_ID"
};

const DOMAIN = "rinix.online";
const ADMIN_EMAIL = "info@rinix.online";
const RESERVED_HANDLES = new Set([
  "admin","administrator","support","help","moderator","mod","info",
  "root","postmaster","webmaster","abuse","security","noreply","no-reply",
  "billing","contact","system","staff","team","official","sales","sysadmin"
]);
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])?$/;

const isDemoMode = FIREBASE_CONFIG.apiKey.startsWith("REPLACE_WITH");

/* -------------------------------------------------------------------------
   Firebase bootstrap (compat build, loaded via CDN script tags in index.html)
   Falls back to an in-memory + localStorage demo backend when unconfigured.
   ------------------------------------------------------------------------- */
let auth = null;
let db = null;

function initFirebase(){
  if (isDemoMode) return;
  try{
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
  }catch(err){
    console.error("Firebase init failed, falling back to demo mode.", err);
  }
}

/* -------------------------------------------------------------------------
   Demo backend (localStorage-backed) — mirrors the shape of the real
   Firestore calls below so swapping in live Firebase is a drop-in change.
   ------------------------------------------------------------------------- */
const DemoStore = {
  key: "rinix_demo_state_v1",
  read(){
    try{ return JSON.parse(localStorage.getItem(this.key)) || { users:{}, handles:{}, current:null }; }
    catch{ return { users:{}, handles:{}, current:null }; }
  },
  write(state){ localStorage.setItem(this.key, JSON.stringify(state)); }
};

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const state = {
  user: null,          // { uid, handle, email }
  mailbox: [],
  activeMailId: null,
  activeFolder: "inbox",
  mobileView: "list",  // list | detail | compose | dev
};

/* -------------------------------------------------------------------------
   Utilities
   ------------------------------------------------------------------------- */
function $(sel, root=document){ return root.querySelector(sel); }
function $all(sel, root=document){ return [...root.querySelectorAll(sel)]; }

function toast(message, type=""){
  const stack = $("#toast-stack");
  const el = document.createElement("div");
  el.className = `toast ${type}`.trim();
  el.textContent = message;
  stack.appendChild(el);
  requestAnimationFrame(()=> el.classList.add("show"));
  setTimeout(()=>{
    el.classList.remove("show");
    setTimeout(()=> el.remove(), 250);
  }, 3200);
}

function escapeHtml(str){
  return str.replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function timeAgo(iso){
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff/60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins/60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs/24)}d`;
}

function randomToken(prefix, len=32){
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += chars[b % chars.length];
  return `${prefix}_${out}`;
}

/* -------------------------------------------------------------------------
   Handle validation + atomic reservation
   ------------------------------------------------------------------------- */
function validateHandleFormat(handle){
  if (!handle) return "Enter a handle.";
  if (handle.length < 3) return "At least 3 characters.";
  if (handle.length > 30) return "30 characters max.";
  if (!HANDLE_PATTERN.test(handle)) return "Lowercase letters, numbers, dots, dashes, underscores only.";
  if (RESERVED_HANDLES.has(handle)) return "This handle is reserved for system routing.";
  return null;
}

/**
 * Checks + (optionally) reserves a handle atomically.
 * Live mode: Firestore transaction on usernames/{handle} — the transaction
 * read+write pair guarantees no two clients can win the same handle even
 * under concurrent signups.
 * Demo mode: single-threaded localStorage stand-in with equivalent checks.
 */
async function reserveHandle(handle, uid){
  const formatError = validateHandleFormat(handle);
  if (formatError) throw new Error(formatError);

  if (isDemoMode){
    const stateStore = DemoStore.read();
    if (stateStore.handles[handle]) throw new Error("Handle already taken.");
    stateStore.handles[handle] = uid;
    DemoStore.write(stateStore);
    return true;
  }

  const ref = db.collection("usernames").doc(handle);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) throw new Error("Handle already taken.");
    tx.set(ref, {
      uid,
      email: `${handle}@${DOMAIN}`,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
  return true;
}

async function checkHandleAvailability(handle){
  const formatError = validateHandleFormat(handle);
  if (formatError) return { available:false, reason:formatError };

  if (isDemoMode){
    const stateStore = DemoStore.read();
    return stateStore.handles[handle]
      ? { available:false, reason:"Already taken." }
      : { available:true };
  }
  const snap = await db.collection("usernames").doc(handle).get();
  return snap.exists ? { available:false, reason:"Already taken." } : { available:true };
}

/* -------------------------------------------------------------------------
   Auth flows
   ------------------------------------------------------------------------- */
async function signUp(handle, password){
  const email = `${handle}@${DOMAIN}`;

  if (isDemoMode){
    const uid = `demo_${handle}`;
    const stateStore = DemoStore.read();
    if (stateStore.users[uid]) throw new Error("Account already exists.");
    await reserveHandle(handle, uid);
    stateStore.users[uid] = { uid, handle, email, password };
    stateStore.current = uid;
    DemoStore.write(stateStore);
    return { uid, handle, email };
  }

  // Reserve the handle BEFORE creating the auth account so a lost race
  // never leaves an orphaned auth user with no handle.
  const tempUid = `pending_${handle}_${Date.now()}`;
  await reserveHandle(handle, tempUid);

  try{
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await db.collection("usernames").doc(handle).set({ uid: cred.user.uid }, { merge:true });
    await db.collection("users").doc(cred.user.uid).set({
      handle, email, createdAt: firebase.firestore.FieldValue.serverTimestamp(), reserved:false
    });
    return { uid: cred.user.uid, handle, email };
  }catch(err){
    // Roll back the handle reservation if account creation failed downstream.
    await db.collection("usernames").doc(handle).delete().catch(()=>{});
    throw err;
  }
}

async function signIn(handle, password){
  const email = `${handle}@${DOMAIN}`;
  if (isDemoMode){
    const stateStore = DemoStore.read();
    const match = Object.values(stateStore.users).find(u => u.handle === handle);
    if (!match || match.password !== password) throw new Error("Invalid handle or password.");
    stateStore.current = match.uid;
    DemoStore.write(stateStore);
    return { uid: match.uid, handle, email };
  }
  const cred = await auth.signInWithEmailAndPassword(email, password);
  return { uid: cred.user.uid, handle, email };
}

function signOutUser(){
  if (isDemoMode){
    const stateStore = DemoStore.read();
    stateStore.current = null;
    DemoStore.write(stateStore);
  } else if (auth){
    auth.signOut();
  }
  state.user = null;
  renderAuthState();
  toast("Signed out.");
}

/* -------------------------------------------------------------------------
   Demo mailbox seed (stands in for the Zoho IMAP proxy — see README note
   in Architecture.md: live mail requires a server-side SMTP/IMAP bridge)
   ------------------------------------------------------------------------- */
function seedMailbox(handle){
  const now = Date.now();
  return [
    {
      id:"m1", unread:true,
      from:`Rinix Team <${ADMIN_EMAIL}>`, subject:"Welcome to Rinix Mail",
      snippet:`Your handle ${handle}@${DOMAIN} is now active.`,
      body:`Hi,\n\nYour address ${handle}@${DOMAIN} is live. From here you can send mail, generate API keys for programmatic access, and manage your inbox.\n\nIf you ever need help, reply to this thread — it routes straight to ${ADMIN_EMAIL}.\n\n— Rinix Team`,
      date:new Date(now-3600e3).toISOString(), verified:true
    },
    {
      id:"m2", unread:true,
      from:"Rinix Security <info@rinix.online>", subject:"Tip: recognizing phishing attempts",
      snippet:"Rinix will never ask for your password by email.",
      body:`A quick reminder: Rinix staff will never ask for your password, recovery codes, or API keys over email.\n\nIf a message claiming to be from Rinix asks for credentials or urges immediate action, forward it to ${ADMIN_EMAIL} and we'll investigate.`,
      date:new Date(now-86400e3).toISOString(), verified:true
    },
    {
      id:"m3", unread:false,
      from:"billing-alert@r1nix-secure.com", subject:"URGENT: Your mailbox will be suspended",
      snippet:"Click here immediately to verify your account or lose access...",
      body:`Click here immediately to verify your account or lose access within 24 hours.\n\n[This is a sample scam email included to demonstrate the anti-phishing badge — note the lookalike domain r1nix-secure.com, which is not rinix.online.]`,
      date:new Date(now-172800e3).toISOString(), scam:true
    }
  ];
}

/* -------------------------------------------------------------------------
   Rendering
   ------------------------------------------------------------------------- */
function renderAuthState(){
  const loggedIn = !!state.user;
  $("#app-shell").classList.toggle("active", loggedIn);
  $("#marketing-view").classList.toggle("hidden", loggedIn);
  if (loggedIn){
    $("#topbar-avatar").textContent = state.user.handle.slice(0,2).toUpperCase();
    $("#topbar-email").textContent = state.user.email;
    state.mailbox = seedMailbox(state.user.handle);
    renderMailList();
    renderDevPortal();
  }
}

function renderMailList(){
  const list = $("#mail-list-items");
  list.innerHTML = "";
  const unreadCount = state.mailbox.filter(m=>m.unread).length;
  $("#inbox-count").textContent = unreadCount || "";

  state.mailbox.forEach(mail=>{
    const row = document.createElement("div");
    row.className = `mail-item ${mail.unread ? "unread":""} ${mail.id===state.activeMailId ? "active":""}`;
    row.dataset.id = mail.id;
    row.innerHTML = `
      <div class="mail-item-top">
        <span class="from">${escapeHtml(mail.from)}</span>
        <time>${timeAgo(mail.date)}</time>
      </div>
      <div class="subject">${escapeHtml(mail.subject)}</div>
      <div class="snippet">${escapeHtml(mail.snippet)}</div>
      ${mail.scam ? '<span class="scam-badge">⚠ Suspected scam</span>' : ""}
      ${mail.verified ? '<span class="verified-badge">✓ Verified sender</span>' : ""}
    `;
    row.addEventListener("click", ()=> openMail(mail.id));
    list.appendChild(row);
  });
}

function openMail(id){
  state.activeMailId = id;
  const mail = state.mailbox.find(m=>m.id===id);
  if (!mail) return;
  mail.unread = false;
  renderMailList();

  $("#detail-empty").classList.add("hidden");
  $("#detail-content").classList.remove("hidden");
  $("#detail-subject").textContent = mail.subject;
  $("#detail-from").textContent = mail.from;
  $("#detail-date").textContent = new Date(mail.date).toLocaleString();
  $("#detail-body").textContent = mail.body;
  $("#detail-badge").innerHTML = mail.scam
    ? '<span class="scam-badge">⚠ Suspected scam — do not click links or share credentials</span>'
    : mail.verified ? '<span class="verified-badge">✓ Verified Rinix sender</span>' : "";

  if (window.innerWidth <= 1023) setMobileView("detail");
}

function renderDevPortal(){
  $("#dev-email").textContent = state.user.email;
  $("#dev-uid").textContent = state.user.uid;
  $("#dev-imap").textContent = `imap.zoho.com:993 (SSL) — user ${state.user.email}`;
  $("#dev-smtp").textContent = `smtp.zoho.com:465 (SSL) — user ${state.user.email}`;
}

/* -------------------------------------------------------------------------
   API key generation (client-side demo; production should mint + hash
   server-side and store only a hash, never the raw key, in Firestore)
   ------------------------------------------------------------------------- */
async function generateApiKey(){
  const key = randomToken("rnx_live", 32);
  const box = $("#api-key-output");
  box.textContent = key;
  box.parentElement.classList.remove("hidden");

  if (!isDemoMode && db && state.user){
    await db.collection("users").doc(state.user.uid).collection("apiKeys").add({
      prefix: key.slice(0,12),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
      // NOTE: store a hash (e.g. SHA-256) of the full key server-side in a
      // real deployment; never persist the raw secret client-side or in
      // plaintext in Firestore.
    }).catch(err=>console.error("Key log failed", err));
  }
  toast("API key generated. Copy it now — it won't be shown again.", "success");
}

/* -------------------------------------------------------------------------
   Composer
   ------------------------------------------------------------------------- */
async function sendMail(to, subject, body){
  // A flat static-hosting repo has no server runtime of its own, so actual
  // SMTP relay through Zoho requires a serverless endpoint (e.g. Vercel
  // function) that this client calls. We attempt that endpoint first and
  // fall back to a mailto: draft so composing always works even before
  // that backend is wired up.
  try{
    const res = await fetch("/api/send", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ from: state.user?.email, to, subject, body })
    });
    if (!res.ok) throw new Error("send endpoint unavailable");
    toast("Message sent.", "success");
  }catch{
    const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
    toast("Live send isn't configured yet — opened your default mail app instead.");
  }
}

/* -------------------------------------------------------------------------
   Mobile view switching
   ------------------------------------------------------------------------- */
function setMobileView(view){
  state.mobileView = view;
  $("#mail-list").classList.toggle("mobile-active", view==="list");
  $("#detail-pane").classList.toggle("mobile-active", view==="detail" || view==="compose" || view==="dev");
  $("#composer-panel").classList.toggle("hidden", view!=="compose");
  $("#dev-panel").classList.toggle("hidden", view!=="dev");
  $("#detail-view").classList.toggle("hidden", view!=="detail");
  $all(".bottom-nav button").forEach(b=> b.classList.toggle("active", b.dataset.view===view));
}

/* -------------------------------------------------------------------------
   Wire up UI
   ------------------------------------------------------------------------- */
function initHandlePicker(){
  const input = $("#hero-handle-input");
  const status = $("#hero-handle-status");
  let debounceTimer;

  input.addEventListener("input", ()=>{
    clearTimeout(debounceTimer);
    const val = input.value.trim().toLowerCase();
    input.value = val;
    if (!val){ status.textContent=""; status.className="handle-status"; return; }
    status.textContent = "Checking…";
    status.className = "handle-status muted";
    debounceTimer = setTimeout(async ()=>{
      const result = await checkHandleAvailability(val);
      status.textContent = result.available ? `${val}@${DOMAIN} is available` : result.reason;
      status.className = `handle-status ${result.available ? "ok":"bad"}`;
    }, 350);
  });

  $("#hero-claim-btn").addEventListener("click", ()=>{
    const val = input.value.trim().toLowerCase();
    const err = validateHandleFormat(val);
    if (err){ status.textContent = err; status.className = "handle-status bad"; return; }
    openAuthModal("signup", val);
  });
}

function openAuthModal(mode, prefillHandle=""){
  $("#auth-modal-backdrop").classList.remove("hidden");
  setAuthMode(mode);
  if (prefillHandle) $("#auth-handle").value = prefillHandle;
}
function closeAuthModal(){
  $("#auth-modal-backdrop").classList.add("hidden");
  $("#auth-error").textContent = "";
}
function setAuthMode(mode){
  const isSignup = mode === "signup";
  $("#auth-title").textContent = isSignup ? "Claim your handle" : "Welcome back";
  $("#auth-sub").textContent = isSignup
    ? `Pick a unique username@${DOMAIN} identity.`
    : `Sign in with your ${DOMAIN} handle.`;
  $("#auth-submit").textContent = isSignup ? "Create account" : "Sign in";
  $("#auth-modal").dataset.mode = mode;
  $("#auth-switch-copy").textContent = isSignup ? "Already have an account?" : "New to Rinix Mail?";
  $("#auth-switch-btn").textContent = isSignup ? "Sign in" : "Create one";
}

function initAuthModal(){
  $("#auth-switch-btn").addEventListener("click", ()=>{
    const current = $("#auth-modal").dataset.mode;
    setAuthMode(current === "signup" ? "signin" : "signup");
  });
  $("#modal-close-btn").addEventListener("click", closeAuthModal);
  $("#auth-modal-backdrop").addEventListener("click", (e)=>{
    if (e.target.id === "auth-modal-backdrop") closeAuthModal();
  });

  $("#auth-form").addEventListener("submit", async (e)=>{
    e.preventDefault();
    const mode = $("#auth-modal").dataset.mode;
    const handle = $("#auth-handle").value.trim().toLowerCase();
    const password = $("#auth-password").value;
    const errBox = $("#auth-error");
    const submitBtn = $("#auth-submit");
    errBox.textContent = "";

    const formatErr = validateHandleFormat(handle);
    if (formatErr){ errBox.textContent = formatErr; return; }
    if (password.length < 8){ errBox.textContent = "Password must be at least 8 characters."; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = "Please wait…";
    try{
      const user = mode === "signup"
        ? await signUp(handle, password)
        : await signIn(handle, password);
      state.user = user;
      closeAuthModal();
      renderAuthState();
      toast(mode === "signup" ? "Account created — welcome!" : "Signed in.", "success");
    }catch(err){
      errBox.textContent = err.message || "Something went wrong.";
    }finally{
      submitBtn.disabled = false;
      submitBtn.textContent = mode === "signup" ? "Create account" : "Sign in";
    }
  });
}

function initAppShellNav(){
  $all(".bottom-nav button").forEach(btn=>{
    btn.addEventListener("click", ()=> setMobileView(btn.dataset.view));
  });
  $all("[data-desktop-nav]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      $all("[data-desktop-nav]").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.dataset.desktopNav;
      $("#composer-panel").classList.toggle("hidden", view!=="compose");
      $("#dev-panel").classList.toggle("hidden", view!=="dev");
      $("#detail-view").classList.toggle("hidden", view!=="detail");
      if (view==="inbox"){
        $("#composer-panel").classList.add("hidden");
        $("#dev-panel").classList.add("hidden");
        $("#detail-view").classList.remove("hidden");
      }
    });
  });
  $("#signout-btn").addEventListener("click", signOutUser);
  $("#generate-key-btn").addEventListener("click", generateApiKey);

  $("#compose-form").addEventListener("submit", (e)=>{
    e.preventDefault();
    const to = $("#compose-to").value.trim();
    const subject = $("#compose-subject").value.trim();
    const body = $("#compose-body").value.trim();
    if (!to || !subject){ toast("Add a recipient and subject.", "error"); return; }
    sendMail(to, subject, body);
    e.target.reset();
  });
}

/* Service worker registration lives in sw-register.js (loaded separately
   from index.html) so it runs independently of app boot / auth state. */

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */
function boot(){
  initFirebase();
  initHandlePicker();
  initAuthModal();
  initAppShellNav();

  $all("[data-open-signup]").forEach(el=> el.addEventListener("click", ()=> openAuthModal("signup")));
  $all("[data-open-signin]").forEach(el=> el.addEventListener("click", ()=> openAuthModal("signin")));

  // Restore demo session, if any.
  if (isDemoMode){
    const stateStore = DemoStore.read();
    if (stateStore.current && stateStore.users[stateStore.current]){
      state.user = stateStore.users[stateStore.current];
    }
  }
  renderAuthState();

  const loader = $("#app-loading");
  if (loader) loader.classList.add("hidden");
}

if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", boot);
}else{
  boot();
}
