"use strict";

/* Path layout matches working testprox: BASE has no trailing slash */
const BASE = (() => {
  let p = location.pathname || "/";
  p = p.replace(/\/index\.html$/i, "");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  // bare domain root
  if (p === "/" || p === "") return "";
  return p;
})();
const REPO_PATH = BASE ? BASE + "/" : "/";
const IMG = REPO_PATH + "image/";
const FAVI = IMG + "favi.png";
const SCRAMJET_PREFIX = BASE + "/service/";
const SCRAMJET_FILES = {
  all: BASE + "/scramjet/scramjet.all.js",
  sync: BASE + "/scramjet/scramjet.sync.js",
  wasm: BASE + "/scramjet/scramjet.wasm.wasm"
};
const BAREMUX_SCRIPT = BASE + "/baremux/index.js";
const BAREMUX_WORKER = BASE + "/baremux/worker.js";
const EPOXY_MODULE = BASE + "/epoxy/index.mjs";
const LIBCURL_MODULE = BASE + "/libcurl/indexmjs.mjs";
const DEFAULT_WISP = "wss://serv-1-va.onrender.com/";
const SW_URL = BASE + "/sw.js";
const SW_SCOPE = BASE + "/";
const MAX_TABS = 20;
const SEARCH_ENGINES = {
  duckduckgo: { id: "duckduckgo", name: "DuckDuckGo", prefix: "https://duckduckgo.com/?q=" },
  google: { id: "google", name: "Google", prefix: "https://www.google.com/search?q=" },
  bing: { id: "bing", name: "Bing", prefix: "https://www.bing.com/search?pglt=299&q=" },
  brave: { id: "brave", name: "Brave", prefix: "https://search.brave.com/search?q=" }
};

/** Built-in Wisp servers (display names only in UI) */
const WISP_BUILTIN = [
  { id: "va1", name: "Virginia Server 1", url: "wss://serv-1-va.onrender.com/" },
  { id: "va2", name: "Virginia Server 2", url: "wss://serv-2-va.onrender.com/" },
  { id: "oh3", name: "Ohio Server 3", url: "wss://serv-3-oh.onrender.com/" },
  { id: "or4", name: "Oregon Server 4", url: "wss://serv-4-or.onrender.com/" },
  { id: "s5", name: "Anura Server", url: "wss://anura.pro/" }
];

function allWispServers() {
  const custom = (settings && Array.isArray(settings.customServers)) ? settings.customServers : [];
  return WISP_BUILTIN.concat(custom);
}

const CLOAK_PRESETS = {
  drive: { title: "Home - Google Drive", icon: IMG + "favi/drive.png" },
  gmail: { title: null, icon: IMG + "favi/gmail.png", dynamic: "gmail" },
  docs: { title: "Google Docs", icon: IMG + "favi/docs.png" },
  "campus-student": { title: "Campus Student", icon: IMG + "favi/campus-student.png" },
  "campus-grades": { title: "Grades | Infinite Campus", icon: IMG + "favi/campus-student.png" },
  "campus-profile": { title: "Student Profile | Home | Infinite Campus", icon: IMG + "favi/campus-student.png" },
  "campus-assignments": { title: "Assignments | Infinite Campus", icon: IMG + "favi/campus-student.png" },
  veil: { title: "Veil", icon: FAVI }
};

function resolveCloakPreset(id) {
  const p = CLOAK_PRESETS[id];
  if (!p) return null;
  if (p.dynamic === "gmail") {
    let email = "";
    try {
      const meta = JSON.parse(localStorage.getItem("veil_access_meta") || "null");
      if (meta && meta.email) email = meta.email;
    } catch (e) {}
    if (!email && window.VeilAccess && typeof window.VeilAccess.getMeta === "function") {
      try {
        const m = window.VeilAccess.getMeta();
        if (m && m.email) email = m.email;
      } catch (e) {}
    }
    const n = 200 + Math.floor(Math.random() * 1801);
    return {
      title: "Inbox (" + n + ")" + (email ? " - " + email : ""),
      icon: p.icon
    };
  }
  return { title: p.title, icon: p.icon };
}

let engineReady = false;
let engineController = null;
let engineInitPromise = null;
let muxConnection = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load " + src));
    document.head.appendChild(s);
  });
}

function currentWisp() {
  let url = DEFAULT_WISP;
  try {
    if (typeof settings !== "undefined") {
      const all = allWispServers();
      const found = all.find((w) => w.id === settings.wispId);
      if (found && found.url) url = found.url;
    }
  } catch {}
  url = String(url || "").trim();
  // reject garbage like "h" or "wss://h/"
  if (!url || url.length < 12) url = DEFAULT_WISP;
  if (!/^wss?:\/\//i.test(url)) {
    if (/^https:\/\//i.test(url)) url = "wss://" + url.slice(8);
    else if (/^http:\/\//i.test(url)) url = "ws://" + url.slice(7);
    else url = DEFAULT_WISP;
  }
  try {
    const u = new URL(url);
    if (!u.hostname || u.hostname.length < 2) url = DEFAULT_WISP;
  } catch {
    url = DEFAULT_WISP;
  }
  if (!url.endsWith("/")) url += "/";
  return url;
}

function absUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return location.origin + (path.startsWith("/") ? path : "/" + path);
}

function serverDisplayName() {
  try {
    const all = allWispServers();
    const found = all.find((w) => w.id === (settings && settings.wispId));
    return (found && found.name) || "Server";
  } catch {
    return "Server";
  }
}

function engineStatusReady() {
  const tname = (settings && settings.transport === "libcurl") ? "Libcurl" : "Epoxy";
  return "Ready - " + tname + " - " + serverDisplayName();
}

function transportModule() {
  if (typeof settings !== "undefined" && settings.transport === "libcurl") return LIBCURL_MODULE;
  return EPOXY_MODULE;
}

/** Exact same logic as working testprox app.js */
async function ensureScramjetDB() {
  const dbs = await indexedDB.databases?.() ?? [];
  const existing = dbs.find((d) => d && d.name === "$scramjet");
  if (!existing) return;

  const stores = await new Promise((resolve) => {
    const req = indexedDB.open("$scramjet");
    req.onsuccess = () => {
      const db = req.result;
      const names = [...db.objectStoreNames];
      db.close();
      resolve(names);
    };
    req.onerror = () => resolve([]);
  });

  if (stores.length > 0) return; // healthy

  await Promise.race([
    new Promise((resolve) => {
      const del = indexedDB.deleteDatabase("$scramjet");
      del.onsuccess = del.onerror = del.onblocked = () => resolve();
    }),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
}

/** Exact order as working testprox: DB -> init -> register SW -> transport */
async function initEngine() {
  if (engineInitPromise) return engineInitPromise;
  engineInitPromise = (async () => {
    const status = document.getElementById("engineStatus");
    try {
      if (!window.BareMux) await loadScript(BAREMUX_SCRIPT);
      if (!window.$scramjetLoadController && !window.ScramjetController) {
        await loadScript(SCRAMJET_FILES.all);
      }
      if (!window.BareMux) throw new Error("BareMux did not load.");
      if (!("serviceWorker" in navigator)) throw new Error("Service workers unavailable.");

      if (status) status.textContent = "Checking Scramjet DB...";
      try { await ensureScramjetDB(); } catch (err) { console.warn("DB check failed", err); }

      if (status) status.textContent = "Starting Scramjet...";
      const loaded = typeof window.$scramjetLoadController === "function"
        ? window.$scramjetLoadController()
        : null;
      const Controller = (loaded && loaded.ScramjetController) || window.ScramjetController;
      if (typeof Controller !== "function") throw new Error("Scramjet controller unavailable.");

      engineController = new Controller({
        prefix: SCRAMJET_PREFIX,
        files: {
          wasm: SCRAMJET_FILES.wasm,
          all: SCRAMJET_FILES.all,
          sync: SCRAMJET_FILES.sync
        },
        flags: {
          captureErrors: true,
          strictRewrites: true,
          rewriterLogs: false
        }
      });

      try {
        await engineController.init();
      } catch (err) {
        if (String(err.message || err).includes("object stores") ||
            String(err.message || err).includes("IDBDatabase")) {
          console.warn("IDB error, force-clear and retry");
          try { indexedDB.deleteDatabase("$scramjet"); } catch {}
          await new Promise((r) => setTimeout(r, 400));
          await engineController.init();
        } else {
          throw err;
        }
      }

      if (status) status.textContent = "Registering service worker...";
      await navigator.serviceWorker.register(SW_URL, {
        scope: SW_SCOPE,
        updateViaCache: "none"
      });
      await navigator.serviceWorker.ready;

      if (status) status.textContent = "Connecting transport...";
      await applyMuxTransport();

      engineReady = true;
      if (status) status.textContent = engineStatusReady();
      try { pushAdblockToSW(); } catch (e) {}
    } catch (err) {
      console.error(err);
      engineReady = false;
      if (status) status.textContent = (err && err.message) || String(err);
      throw err;
    }
  })();
  return engineInitPromise;
}

async function applyMuxTransport() {
  const wisp = currentWisp();
  const preferred = transportModule();
  const fallback = preferred === LIBCURL_MODULE ? EPOXY_MODULE : LIBCURL_MODULE;
  muxConnection = new BareMux.BareMuxConnection(BAREMUX_WORKER);
  try {
    await muxConnection.setTransport(preferred, [{ wisp }]);
    return preferred;
  } catch (err) {
    console.warn("[veil] transport failed, trying fallback", err);
    muxConnection = new BareMux.BareMuxConnection(BAREMUX_WORKER);
    await muxConnection.setTransport(fallback, [{ wisp }]);
    settings.transport = fallback === LIBCURL_MODULE ? "libcurl" : "epoxy";
    return fallback;
  }
}

async function reconnectTransport() {
  try {
    await applyMuxTransport();
    const status = document.getElementById("engineStatus");
    if (status) status.textContent = engineStatusReady();
  } catch (e) {
    console.warn("reconnect failed", e);
    const status = document.getElementById("engineStatus");
    if (status) status.textContent = "Server offline - try another server";
  }
}

const THEMES = {
  matte: { bg: "#101010", bg2: "#151515", bg3: "#1b1b1b", panel: "#181818", panel2: "#202020", border: "#2b2b2b", text: "#f2f2f2", muted: "#888888", accent: "#ffffff", accentText: "#111111", newtab: "#101010" },
  ember: { bg: "#1a0a0a", bg2: "#220e0e", bg3: "#3a1212", panel: "#2a1010", panel2: "#401818", border: "#5a2020", text: "#ffeaea", muted: "#b88888", accent: "#ff4d4d", accentText: "#1a0505", newtab: "#1a0a0a" },
  sunlight: { bg: "#191108", bg2: "#211609", bg3: "#32200c", panel: "#281a0a", panel2: "#3a250e", border: "#513716", text: "#fff8eb", muted: "#bca783", accent: "#ffb84d", accentText: "#241303", newtab: "#191108" },
  forest: { bg: "#0b140e", bg2: "#101b13", bg3: "#17291b", panel: "#132219", panel2: "#1b3020", border: "#29452f", text: "#effff1", muted: "#8da993", accent: "#73c982", accentText: "#071109", newtab: "#0b140e" },
  moonlight: { bg: "#080b12", bg2: "#0d111b", bg3: "#121827", panel: "#101521", panel2: "#171e2d", border: "#263047", text: "#eef3ff", muted: "#8490a7", accent: "#7aa2ff", accentText: "#08101f", newtab: "#080b12" },
  twilight: { bg: "#110d1a", bg2: "#171122", bg3: "#241936", panel: "#1c142b", panel2: "#2b1d40", border: "#412c5c", text: "#f7f0ff", muted: "#a89ab8", accent: "#b88cff", accentText: "#160c24", newtab: "#110d1a" },
  sakura: { bg: "#190e14", bg2: "#21111a", bg3: "#321725", panel: "#28131e", panel2: "#3a1b29", border: "#512538", text: "#fff0f6", muted: "#b991a3", accent: "#ff8fba", accentText: "#250b16", newtab: "#190e14" },
  ocean: { bg: "#06141c", bg2: "#0a1c26", bg3: "#0f2833", panel: "#0c222c", panel2: "#12303c", border: "#1e4554", text: "#e6f7ff", muted: "#7aa0b0", accent: "#3ecfce", accentText: "#042028", newtab: "#06141c" },
  slate: { bg: "#12151a", bg2: "#181c24", bg3: "#222833", panel: "#1a1f28", panel2: "#252b36", border: "#343b4a", text: "#e8ecf4", muted: "#8b93a7", accent: "#9db0ff", accentText: "#10131a", newtab: "#12151a" },
  mono: { bg: "#0c0c0c", bg2: "#141414", bg3: "#1c1c1c", panel: "#161616", panel2: "#222", border: "#333", text: "#eee", muted: "#777", accent: "#ccc", accentText: "#111", newtab: "#0c0c0c" },
  rose: { bg: "#160c10", bg2: "#1e1016", bg3: "#2a1620", panel: "#24141c", panel2: "#321c28", border: "#4a2838", text: "#ffe8f0", muted: "#c090a0", accent: "#ff6b9d", accentText: "#2a0a14", newtab: "#160c10" },
  crimson: { bg: "#140808", bg2: "#1c0c0c", bg3: "#2a1010", panel: "#221010", panel2: "#321818", border: "#5a2020", text: "#ffd6d6", muted: "#c88888", accent: "#e63232", accentText: "#1a0505", newtab: "#140808" },
  amber: { bg: "#161008", bg2: "#1e160c", bg3: "#2a1e10", panel: "#241810", panel2: "#322414", border: "#5a3c18", text: "#fff0d6", muted: "#c8a878", accent: "#ff9f1a", accentText: "#1a1005", newtab: "#161008" },
  lime: { bg: "#0c1408", bg2: "#121c0c", bg3: "#1a2810", panel: "#162214", panel2: "#203018", border: "#3a5028", text: "#f0ffe6", muted: "#98b878", accent: "#8dff4d", accentText: "#0a1405", newtab: "#0c1408" },
  scarlet: { bg: "#1a0606", bg2: "#220a0a", bg3: "#321010", panel: "#281010", panel2: "#3a1414", border: "#6a2020", text: "#ffe0e0", muted: "#d09090", accent: "#ff2a2a", accentText: "#1a0505", newtab: "#1a0606" }
};

const DEFAULT_SETTINGS = {
  theme: "matte", transport: "epoxy", wispId: "default", wispCustom: "",
  launchMode: "manual", backgroundUrl: "", adBlocker: true, maxLoadedTabs: 4, searchEngine: "duckduckgo", wispId: "va1", customServers: [], lockUnload: false, animEnabled: false, animStyle: "orbs", animSpeed: 1, animCount: 18, animSize: 1, animColorA: "#7aa2ff", animColorB: "#b88cff", timeFormat: "12", ...THEMES.matte
};
const DEFAULT_PANIC = { key: "", code: "", url: "https://classroom.google.com" };

let settings = { ...DEFAULT_SETTINGS };
let profile = { name: "", password: "" }; // client-side welcome only
let welcomeClockTimer = null;
let panic = { ...DEFAULT_PANIC };
let bookmarks = [];
let visitHistory = [];
let cloak = { title: "Veil", icon: FAVI };
let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let bindingPanic = false;

const COOKIE = {
  consent: false,
  set(name, value, days = 365) {
    if (!this.consent) return;
    try {
      const expires = new Date(Date.now() + days * 86400000).toUTCString();
      document.cookie = encodeURIComponent(name) + "=" + encodeURIComponent(value) + "; expires=" + expires + "; path=/; SameSite=Lax";
    } catch (e) {}
    try {
      localStorage.setItem("veil_c_" + name, value);
    } catch (e) {}
  },
  get(name) {
    try {
      const target = encodeURIComponent(name) + "=";
      for (const part of document.cookie.split(";")) {
        const p = part.trim();
        if (p.startsWith(target)) return decodeURIComponent(p.slice(target.length));
      }
    } catch (e) {}
    try {
      return localStorage.getItem("veil_c_" + name);
    } catch (e) {}
    return null;
  }
};
const STORAGE = { bookmarks: "veil_bookmarks", settings: "veil_settings", cloak: "veil_cloak", panic: "veil_panic", profile: "veil_profile", history: "veil_history" };

function uid() { return "tab_" + Date.now().toString(36) + "_" + (++tabCounter).toString(36); }
function escapeHTML(v) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  };
  return String(v ?? "").replace(/[&<>"']/g, function (m) { return map[m]; });
}
function getTab(id = activeTabId) { return tabs.find(t => t.id === id) || null; }
function getActiveTab() { return getTab(); }
function isBookmarked(url) { return bookmarks.some(b => b.url === url); }
function faviconFor(url) {
  try {
    const host = new URL(url).hostname;
    return "https://www.google.com/s2/favicons?sz=32&domain=" + encodeURIComponent(host);
  } catch { return FAVI; }
}

function save() {
  if (!COOKIE.consent) return;
  try {
    const b = JSON.stringify(bookmarks);
    const s = JSON.stringify(settings);
    const c = JSON.stringify(cloak);
    const p = JSON.stringify(panic);
    const h = JSON.stringify(visitHistory.slice(0, 200));
    COOKIE.set(STORAGE.bookmarks, b);
    COOKIE.set(STORAGE.settings, s);
    COOKIE.set(STORAGE.cloak, c);
    COOKIE.set(STORAGE.panic, p);
    COOKIE.set(STORAGE.history, h);
    try {
      localStorage.setItem(STORAGE.bookmarks, b);
      localStorage.setItem(STORAGE.settings, s);
      localStorage.setItem(STORAGE.cloak, c);
      localStorage.setItem(STORAGE.panic, p);
      localStorage.setItem(STORAGE.history, h);
    } catch (e2) {}
  } catch (e) { console.warn("save failed", e); }
}
function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE.profile) || COOKIE.get(STORAGE.profile);
    if (raw) profile = { ...profile, ...JSON.parse(raw) };
  } catch {}
}
function saveProfile() {
  try {
    const raw = JSON.stringify({ name: profile.name || "", password: profile.password || "" });
    localStorage.setItem(STORAGE.profile, raw);
    COOKIE.set(STORAGE.profile, raw);
  } catch {}
}
function migrateSettings() {
  if (!settings.wispId || settings.wispId === "default" || settings.wispId === "custom") {
    settings.wispId = "va1";
  }
  if (!SEARCH_ENGINES[settings.searchEngine]) settings.searchEngine = "duckduckgo";
  if (!Array.isArray(settings.customServers)) settings.customServers = [];
  if (settings.animCount == null) settings.animCount = 18;
  if (settings.animSize == null) settings.animSize = 1;
  if (settings.timeFormat !== "12" && settings.timeFormat !== "24") settings.timeFormat = "12";
  // Default launch is always manual unless user explicitly keeps auto in settings UI
  if (settings.launchMode !== "auto" && settings.launchMode !== "manual") {
    settings.launchMode = "manual";
  }
  // Transport: default epoxy, only allow epoxy | libcurl
  if (settings.transport !== "libcurl" && settings.transport !== "epoxy") {
    settings.transport = "epoxy";
  }
  // Theme defaults to matte
  if (!settings.theme || !THEMES[settings.theme]) {
    settings.theme = "matte";
    Object.assign(settings, THEMES.matte);
  }
}
function loadSavedData() {
  loadProfile();
  try {
    const b = COOKIE.get(STORAGE.bookmarks) || localStorage.getItem(STORAGE.bookmarks);
    const s = COOKIE.get(STORAGE.settings) || localStorage.getItem(STORAGE.settings);
    const c = COOKIE.get(STORAGE.cloak) || localStorage.getItem(STORAGE.cloak);
    const p = COOKIE.get(STORAGE.panic) || localStorage.getItem(STORAGE.panic);
    if (b) bookmarks = JSON.parse(b) || [];
    if (s) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s) };
    migrateSettings();
    if (c) cloak = { ...cloak, ...JSON.parse(c) };
    if (p) panic = { ...DEFAULT_PANIC, ...JSON.parse(p) };
    try {
      const h = COOKIE.get(STORAGE.history) || localStorage.getItem(STORAGE.history);
      if (h) visitHistory = JSON.parse(h) || [];
    } catch {}
  } catch (e) { console.warn("load failed", e); }
}

function applyCSSVariables() {
  const root = document.documentElement;
  ["bg", "bg2", "bg3", "panel", "panel2", "border", "text", "muted", "accent", "accentText", "newtab"]
    .forEach(k => root.style.setProperty("--" + k, settings[k]));
}
function isVideoUrl(url) {
  return /\.(mp4|webm|ogg)(\?|#|$)/i.test(url || "");
}

function applyNewTabBackground() {
  const url = (settings.backgroundUrl || "").trim();
  document.querySelectorAll(".newtab-page").forEach((el) => {
    el.querySelectorAll(".newtab-media, .newtab-media-img").forEach((n) => n.remove());
    el.style.backgroundImage = "none";
    if (!url) return;
    if (isVideoUrl(url)) {
      const v = document.createElement("video");
      v.className = "newtab-media";
      v.src = url;
      v.autoplay = true;
      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      el.insertBefore(v, el.firstChild);
      v.play().catch(() => {});
    } else {
      // images, gif, webp, etc.
      const img = document.createElement("img");
      img.className = "newtab-media-img";
      img.src = url;
      img.alt = "";
      el.insertBefore(img, el.firstChild);
    }
  });
}

function imgIcon(name) { return '<img src="' + IMG + name + '" alt="">'; }

function searchPrefix() {
  const id = (settings && settings.searchEngine) || "duckduckgo";
  const eng = SEARCH_ENGINES[id] || SEARCH_ENGINES.duckduckgo;
  return eng.prefix;
}

function normalizeUrl(input) {
  let value = String(input || "").trim();
  if (!value) return null;
  // If user pasted a proxy URL, show/use the real site URL
  value = unwrapProxyUrl(value) || value;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(value)) return "https://" + value;
  return searchPrefix() + encodeURIComponent(value);
}

/** Never show https://...github.io/veil/service/... in the address bar */
function unwrapProxyUrl(href) {
  if (!href || href === "about:blank") return href;
  try {
    const u = new URL(href, location.origin);
    const marker = "/service/";
    const idx = u.pathname.indexOf(marker);
    if (idx === -1) return href;
    let rest = u.pathname.slice(idx + marker.length);
    if (!rest) return href;
    for (let i = 0; i < 4; i++) {
      try {
        const next = decodeURIComponent(rest);
        if (next === rest) break;
        rest = next;
      } catch { break; }
    }
    if (rest.startsWith("http://") || rest.startsWith("https://")) return rest;
  } catch {}
  return href;
}

function openInVeilTab(rawUrl) {
  const value = normalizeUrl(rawUrl);
  if (!value) return;
  // Prefer current tab if it is a real page; otherwise navigate active / new tab
  const cur = getActiveTab();
  if (cur && !cur.isAdmin) {
    activeTabId = cur.id;
    navigate(value);
    return;
  }
  createTab(true);
  navigate(value);
}

/** Trap target=_blank / window.open so sites stay inside Veil tabs */
function trapFrameExternalOpens(page, el) {
  if (!el) return;
  const inject = () => {
    try {
      const w = el.contentWindow;
      const d = el.contentDocument;
      if (!w || !d) return;
      try {
        w.open = function (url) {
          try {
            if (url && String(url) !== "about:blank") {
              const href = String(url);
              // Scramjet may pass absolute proxied URLs
              openInVeilTab(unwrapProxyUrl(href) || href);
            }
          } catch (e) {}
          return null;
        };
      } catch (e) {}
      if (d.__veilTrapClicks) return;
      d.__veilTrapClicks = true;
      d.addEventListener("click", (e) => {
        try {
          const a = e.target && e.target.closest && e.target.closest("a");
          if (!a) return;
          const t = (a.getAttribute("target") || "").toLowerCase();
          if (t === "_blank" || t === "_new" || t === "_parent" || t === "_top") {
            const href = a.href || a.getAttribute("href");
            if (!href || href.startsWith("javascript:")) return;
            e.preventDefault();
            e.stopPropagation();
            openInVeilTab(unwrapProxyUrl(href) || href);
          }
        } catch (err) {}
      }, true);
    } catch (e) {
      // Cross-origin until scramjet rewrites — ignore
    }
  };
  el.addEventListener("load", inject);
  try { inject(); } catch (e) {}
}

function bindFrameEvents(page, frameObj) {
  const el = frameObj.element || frameObj.frame || frameObj;
  const onUrl = (e) => {
    let u = (e && (e.url || e.detail && e.detail.url)) || "";
    if (!u || u === "about:blank") return;
    u = unwrapProxyUrl(u) || u;
    page.url = u;
    page.newTab = false;
    try { page.title = new URL(u).hostname; } catch {}
    page.favicon = faviconFor(u);
    if (page.id === activeTabId) {
      renderTabs();
      renderToolbar();
    } else renderTabs();
  };
  if (typeof frameObj.addEventListener === "function") {
    frameObj.addEventListener("urlchange", onUrl);
  }
  if (el && el.addEventListener) {
    el.addEventListener("load", () => {
      try {
        const loc = el.contentWindow && el.contentWindow.location && el.contentWindow.location.href;
        if (loc) onUrl({ url: loc });
      } catch {}
    });
    trapFrameExternalOpens(page, el);
  }
}

async function createEngineFrame(page, wrapper) {
  if (!engineReady) await initEngine();
  if (!engineReady) {
    wrapper.innerHTML = '<div class="engine-error"><div class="engine-error-box"><h2>Browser engine unavailable</h2><p>Check scramjet/, baremux/, epoxy/, libcurl/, and sw.js.</p><button data-retry-engine>Retry</button></div></div>';
    wrapper.querySelector("[data-retry-engine]").onclick = async () => {
      engineInitPromise = null;
      wrapper.innerHTML = "";
      await createEngineFrame(page, wrapper);
    };
    return;
  }
  try {
    if (page.engineFrame) {
      const existing = page.engineFrame.element || page.engineFrame.frame || page.engineFrame;
      if (existing && existing.isConnected) return;
    }
    let frameObj = engineController && engineController.createFrame && engineController.createFrame();
    if (!frameObj) throw new Error("Scramjet frame API unavailable.");
    const frame = frameObj.element || frameObj.frame || frameObj;
    if (frame.classList) frame.classList.add("engine-frame");
    if (frame.style) {
      frame.style.width = "100%";
      frame.style.height = "100%";
      frame.style.border = "0";
      frame.style.background = "#fff";
    }
    // Do not sandbox the frame - login cookies and OAuth need a normal iframe
    try {
      // Use allow= only (allowfullscreen is ignored when allow is set)
      frame.setAttribute(
        "allow",
        "fullscreen *; clipboard-read *; clipboard-write *; autoplay *; encrypted-media *; picture-in-picture *; payment *"
      );
      frame.removeAttribute("allowfullscreen");
      frame.setAttribute("referrerpolicy", "no-referrer");
    } catch {}
    wrapper.innerHTML = "";
    wrapper.appendChild(frame);
    page.engineFrame = frameObj;
    bindFrameEvents(page, frameObj);
    await goFrame(page, page.url);
  } catch (e) {
    console.error(e);
    wrapper.innerHTML = '<div class="engine-error"><div class="engine-error-box"><h2>Could not open this page</h2><p>' + escapeHTML(e.message) + '</p><button data-retry-engine>Retry</button></div></div>';
    const btn = wrapper.querySelector("[data-retry-engine]");
    if (btn) btn.onclick = async () => { await reconnectTransport(); wrapper.innerHTML = ""; await createEngineFrame(page, wrapper); };
  }
}

async function goFrame(page, url) {
  const frameObj = page.engineFrame;
  if (!frameObj || !url) return;
  const attempt = async () => {
    if (typeof frameObj.go === "function") await frameObj.go(url);
    else if (typeof frameObj.navigate === "function") await frameObj.navigate(url);
    else {
      const el = frameObj.element || frameObj.frame || frameObj;
      if (el instanceof HTMLIFrameElement) el.src = SCRAMJET_PREFIX + encodeURIComponent(url);
    }
  };
  try {
    await attempt();
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/MuxTaskEnded|headers is not iterable|Invalid URL|Failed to fetch|network|Wisp|WebSocket/i.test(msg)) {
      console.warn("[veil] navigation transport error, reconnecting...", msg);
      try {
        // flip transport once if epoxy is flaky
        if (/headers is not iterable|MuxTaskEnded/i.test(msg) && settings.transport !== "libcurl") {
          settings.transport = "libcurl";
        }
        await reconnectTransport();
        await attempt();
      } catch (e2) {
        console.warn("[veil] retry failed", e2);
        const status = document.getElementById("engineStatus");
        if (status) status.textContent = "Connection lost - pick another server";
      }
    } else {
      console.warn(e);
    }
  }
}

function renderTabs() {
  const c = document.getElementById("tabs");
  const tabsHtml = tabs.map(tab =>
    '<div class="tab ' + (tab.id === activeTabId ? "active " : "") + (tab.animOpen ? "opening" : "") + '" data-tab-id="' + tab.id + '">' +
    '<div class="tab-icon"><img src="' + escapeHTML(tab.favicon || FAVI) + '" alt=""></div>' +
    '<div class="tab-title">' + escapeHTML(tab.title) + '</div>' +
    '<button class="tab-close" data-close="' + tab.id + '" aria-label="Close"><img src="' + IMG + 'exit.svg" alt=""></button></div>'
  ).join("");
  c.innerHTML = tabsHtml + '<button class="new-tab" id="newTabBtn" type="button" aria-label="New tab"><img src="' + IMG + 'plus.svg" alt=""></button>';
  tabs.forEach(t => { t.animOpen = false; });
  c.querySelectorAll(".tab").forEach(el => {
    el.addEventListener("click", e => {
      if (e.target.closest(".tab-close")) return;
      switchTab(el.dataset.tabId);
    });
  });
  c.querySelectorAll("[data-close]").forEach(btn =>
    btn.addEventListener("click", e => { e.stopPropagation(); closeTab(btn.dataset.close); })
  );
  const addBtn = document.getElementById("newTabBtn");
  if (addBtn) addBtn.onclick = () => createTab(true);
  requestAnimationFrame(() => { c.scrollLeft = c.scrollWidth; });
}

function formatWelcomeClock(d) {
  const pad = (n) => String(n).padStart(2, "0");
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const MD = pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + "/" + d.getFullYear();
  const use24 = settings && settings.timeFormat === "24";
  let time;
  if (use24) {
    time = pad(d.getHours()) + ":" + mm + ":" + ss;
  } else {
    let h = d.getHours();
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    time = h + ":" + mm + ":" + ss + " " + ap;
  }
  return { time: time, date: MD };
}

function welcomeHTML() {
  const name = (profile && profile.name) ? profile.name : "guest";
  const { time, date } = formatWelcomeClock(new Date());
  return (
    '<div class="welcome-bar">' +
    '<div class="welcome-line">Welcome to Veil, ' + escapeHTML(name) + '.</div>' +
    '<div class="welcome-time">It is currently <span data-welcome-time>' + time + '</span> on <span data-welcome-date>' + date + '</span>.</div>' +
    '</div>'
  );
}

function startWelcomeClock() {
  if (welcomeClockTimer) clearInterval(welcomeClockTimer);
  const tick = () => {
    const { time, date } = formatWelcomeClock(new Date());
    document.querySelectorAll("[data-welcome-time]").forEach((el) => { el.textContent = time; });
    document.querySelectorAll("[data-welcome-date]").forEach((el) => { el.textContent = date; });
  };
  tick();
  welcomeClockTimer = setInterval(tick, 1000);
}

function engineOptionsHTML() {
  const cur = (settings && settings.searchEngine) || "duckduckgo";
  return Object.values(SEARCH_ENGINES).map((e) =>
    '<option value="' + e.id + '"' + (e.id === cur ? " selected" : "") + ">" + e.name + "</option>"
  ).join("");
}

function homepageHTML(pageId) {
  return (
    '<div class="newtab-page"><canvas class="home-fx" data-home-fx></canvas><div class="newtab-overlay">' +
    welcomeHTML() +
    '<div class="newtab-center">' +
    '<div class="veil-mark"><img src="' + FAVI + '" alt="Veil"></div>' +
    '<div class="newtab-title">Veil</div>' +
    '<div class="newtab-sub">Browse quietly. Stay undetected.</div>' +
    '<div class="search-row">' +
    '<div class="search-box" style="width:100%"><span class="home-search-icon"></span>' +
    '<input class="newtab-search" data-page="' + pageId + '" placeholder="Search or enter a site..." autocomplete="off" spellcheck="false">' +
    '</div></div>' +
    '<div class="quick-links">' +
    '<button class="quick-link" title="X" data-url="https://x.com">' + imgIcon("x.svg") + '</button>' +
    '<button class="quick-link" title="Discord" data-url="https://discord.com/">' + imgIcon("discord.svg") + '</button>' +
    '<button class="quick-link" title="Reddit" data-url="https://www.reddit.com/">' + imgIcon("reddit.svg") + '</button>' +
    '<button class="quick-link" title="GeForce NOW" data-url="https://play.geforcenow.com/mall">' + imgIcon("nvidia.svg") + '</button>' +
    '</div>' +
    '<div class="quick-links row2">' +
    '<button class="quick-link soon" title="Games (soon)" data-soon="1">' + imgIcon("games.svg") + '</button>' +
    '<button class="quick-link soon" title="Utilities (soon)" data-soon="1">' + imgIcon("util.svg") + '</button>' +
    '</div>' +
    '<button class="launch-btn" id="launchOptionsBtn" type="button">Launch Options...</button>' +
    '</div></div>' +
    '<div class="time-bar" id="timeBar">Time Remaining: …</div></div>'
  );
}

function wireHome(wrapper, page) {
  applyNewTabBackground();
  startWelcomeClock();
  setupHomeFx(wrapper);
  wrapper.querySelectorAll(".newtab-search").forEach(input => {
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        activeTabId = page.id;
        const q = input.value;
        navigate(q);
      }
    });
  });
  wrapper.querySelectorAll(".quick-link[data-url]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      activeTabId = page.id;
      navigate(btn.getAttribute("data-url") || btn.dataset.url);
    });
  });
  const lob = wrapper.querySelector("#launchOptionsBtn");
  if (lob) lob.onclick = () => openLaunchModal();
}

function ensurePage(page) {
  const viewport = document.getElementById("viewport");
  if (!viewport) return null;
  let wrapper = viewport.querySelector('.page[data-page-id="' + page.id + '"]');
  if (!wrapper) {
    wrapper = document.createElement("section");
    wrapper.className = "page";
    wrapper.dataset.pageId = page.id;
    viewport.appendChild(wrapper);
  }
  // Always (re)fill homepage if this is a new-tab and content is missing
  const needsHome = page.newTab && !wrapper.querySelector(".newtab-page");
  if (needsHome) {
    wrapper.innerHTML = homepageHTML(page.id);
    wireHome(wrapper, page);
  } else if (!page.newTab && !page.isAdmin && !wrapper.querySelector("[data-engine-container], .engine-frame")) {
    const frame = document.createElement("div");
    frame.style.cssText = "width:100%;height:100%";
    frame.dataset.engineContainer = page.id;
    wrapper.appendChild(frame);
    createEngineFrame(page, frame);
  }
  wrapper.classList.toggle("active", page.id === activeTabId);
  wrapper.style.display = page.id === activeTabId ? "block" : "none";
  return wrapper;
}

function prunePages() {
  const viewport = document.getElementById("viewport");
  const ids = new Set(tabs.map(t => t.id));
  viewport.querySelectorAll(".page").forEach(el => {
    if (!ids.has(el.dataset.pageId)) el.remove();
  });
}

function maxLoaded() {
  const n = Number(settings && settings.maxLoadedTabs);
  if (!Number.isFinite(n)) return 8;
  return Math.min(MAX_TABS, Math.max(1, Math.round(n)));
}

function showActiveOnly() {
  const viewport = document.getElementById("viewport");
  if (!viewport) return;
  const limit = maxLoaded();
  const ranked = tabs.slice().sort((a, b) => {
    if (a.id === activeTabId) return -1;
    if (b.id === activeTabId) return 1;
    return (b.lastActive || 0) - (a.lastActive || 0);
  });
  const keep = new Set(ranked.slice(0, limit).map((x) => x.id));

  tabs.forEach((tab) => {
    const page = viewport.querySelector('.page[data-page-id="' + tab.id + '"]');
    if (!page) return;
    const active = tab.id === activeTabId;
    page.classList.toggle("active", active);
    page.style.display = active ? "block" : "none";

    if (!keep.has(tab.id) && tab.engineFrame) {
      try {
        const f = tab.engineFrame.element || tab.engineFrame.frame;
        if (f && f.remove) f.remove();
      } catch {}
      tab.engineFrame = null;
      if (!tab.newTab && tab.url) {
        page.dataset.unloaded = "1";
      }
    }
  });
}

function switchTab(id) {
  activeTabId = id;
  const tab = getTab(id);
  if (tab) tab.lastActive = Date.now();
  showActiveOnly();
  if (tab && !tab.newTab && tab.url && !tab.engineFrame) {
    const pageEl = document.querySelector('.page[data-page-id="' + tab.id + '"]');
    if (pageEl) {
      pageEl.innerHTML = "";
      pageEl.dataset.unloaded = "0";
      const frame = document.createElement("div");
      frame.style.cssText = "width:100%;height:100%";
      frame.dataset.engineContainer = tab.id;
      pageEl.appendChild(frame);
      createEngineFrame(tab, frame);
    }
  }
  renderTabs();
  renderToolbar();
}

function renderToolbar() {
  const page = getActiveTab();
  document.getElementById("address").value = page && page.url ? page.url : "";
  document.getElementById("backBtn").disabled = !page || !page.url;
  document.getElementById("forwardBtn").disabled = !page || !page.url;
  const b = document.getElementById("bookmarkBtn");
  if (page && page.url && isBookmarked(page.url)) b.classList.add("saved");
  else b.classList.remove("saved");
}

function renderChrome() {
  try { renderTabs(); } catch (e) { console.warn("renderTabs", e); }
  try { renderToolbar(); } catch (e) { console.warn("renderToolbar", e); }
  try { renderBookmarks(); } catch (e) { console.warn("renderBookmarks", e); }
  try { loadColorInputs(); } catch (e) { console.warn("loadColorInputs", e); }
  try { loadCloakInputs(); } catch (e) { console.warn("loadCloakInputs", e); }
  try { loadPanicInputs(); } catch (e) { console.warn("loadPanicInputs", e); }
  try { highlightTheme(); } catch (e) { console.warn("highlightTheme", e); }
  try { fillWispSelect(); } catch (e) { console.warn("fillWispSelect", e); }
}

async function navigate(raw) {
  let page = getActiveTab();
  if (!page) {
    createTab(true);
    page = getActiveTab();
  }
  if (!page) return;
  const value = normalizeUrl(raw);
  if (!value) return;
  activeTabId = page.id;
  page.url = value;
  page.newTab = false;
  page.isAdmin = false;
  page.favicon = faviconFor(value);
  try { page.title = new URL(value).hostname; } catch { page.title = "Veil"; }
  pushVisitHistory(value, page.title);
  if (!Array.isArray(page.history)) page.history = [];
  if (page.historyIndex < page.history.length - 1) page.history = page.history.slice(0, page.historyIndex + 1);
  page.history.push(value);
  page.historyIndex = page.history.length - 1;

  const viewport = document.getElementById("viewport");
  if (!viewport) return;
  let wrapper = viewport.querySelector('.page[data-page-id="' + page.id + '"]');
  if (!wrapper) {
    wrapper = document.createElement("section");
    wrapper.className = "page active";
    wrapper.dataset.pageId = page.id;
    viewport.appendChild(wrapper);
  }
  wrapper.classList.add("active");
  wrapper.style.display = "block";

  // Drop homepage content before opening engine
  if (wrapper.querySelector(".newtab-page")) {
    page.engineFrame = null;
    wrapper.innerHTML = "";
  }

  try {
    if (page.engineFrame) {
      const existing = page.engineFrame.element || page.engineFrame.frame || page.engineFrame;
      if (existing && existing.isConnected) {
        await goFrame(page, value);
      } else {
        page.engineFrame = null;
        wrapper.innerHTML = "";
        const frame = document.createElement("div");
        frame.style.cssText = "width:100%;height:100%";
        frame.dataset.engineContainer = page.id;
        wrapper.appendChild(frame);
        await createEngineFrame(page, frame);
      }
    } else {
      wrapper.innerHTML = "";
      const frame = document.createElement("div");
      frame.style.cssText = "width:100%;height:100%";
      frame.dataset.engineContainer = page.id;
      wrapper.appendChild(frame);
      await createEngineFrame(page, frame);
    }
  } catch (err) {
    console.error("navigate failed", err);
    wrapper.innerHTML = '<div class="engine-error"><div class="engine-error-box"><h2>Could not open this page</h2><p>' + escapeHTML((err && err.message) || String(err)) + '</p><button data-retry-nav type="button">Retry</button></div></div>';
    const btn = wrapper.querySelector("[data-retry-nav]");
    if (btn) btn.onclick = () => navigate(value);
  }
  showActiveOnly();
  renderChrome();
}

async function goBack() {
  const p = getActiveTab();
  if (!p || p.newTab) return;
  if (p.engineFrame && typeof p.engineFrame.back === "function") {
    try { await p.engineFrame.back(); renderChrome(); return; } catch {}
  }
  try {
    const el = p.engineFrame && (p.engineFrame.element || p.engineFrame.frame);
    if (el && el.contentWindow && el.contentWindow.history) {
      el.contentWindow.history.back();
      renderChrome();
      return;
    }
  } catch {}
  if (!p.history || p.historyIndex <= 0) return;
  p.historyIndex--;
  p.url = p.history[p.historyIndex];
  p.newTab = false;
  await goFrame(p, p.url);
  renderChrome();
}
async function goForward() {
  const p = getActiveTab();
  if (!p || p.newTab) return;
  if (p.engineFrame && typeof p.engineFrame.forward === "function") {
    try { await p.engineFrame.forward(); renderChrome(); return; } catch {}
  }
  try {
    const el = p.engineFrame && (p.engineFrame.element || p.engineFrame.frame);
    if (el && el.contentWindow && el.contentWindow.history) {
      el.contentWindow.history.forward();
      renderChrome();
      return;
    }
  } catch {}
  if (!p.history || p.historyIndex >= p.history.length - 1) return;
  p.historyIndex++;
  p.url = p.history[p.historyIndex];
  p.newTab = false;
  await goFrame(p, p.url);
  renderChrome();
}
function reload() {
  const p = getActiveTab();
  if (!p) return;
  if (!p.url) { goHome(); return; }
  if (p.engineFrame && typeof p.engineFrame.reload === "function") p.engineFrame.reload();
  else goFrame(p, p.url);
}


function veilConfirm(title, message) {
  return new Promise((resolve) => {
    const existing = document.querySelector(".modal-overlay.veil-confirm");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay veil-confirm";
    overlay.innerHTML =
      '<div class="modal-box">' +
      "<h2>" + escapeHTML(title || "Confirm") + "</h2>" +
      '<p style="margin-top:10px;color:var(--muted);font-size:13px;line-height:1.55">' + escapeHTML(message || "") + "</p>" +
      '<div class="modal-actions">' +
      '<button class="modal-cancel" type="button">No</button>' +
      '<button class="modal-go" type="button">Yes</button>' +
      "</div></div>";
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector(".modal-cancel").onclick = () => done(false);
    overlay.querySelector(".modal-go").onclick = () => done(true);
    overlay.onclick = (e) => { if (e.target === overlay) done(false); };
  });
}

function pushVisitHistory(url, title) {
  if (!url || url === "about:blank") return;
  try {
    const u = new URL(url, location.href).href;
    visitHistory = visitHistory.filter((x) => x.url !== u);
    visitHistory.unshift({ id: uid(), url: u, title: title || u, at: Date.now() });
    if (visitHistory.length > 200) visitHistory.length = 200;
    save();
  } catch {}
}

function renderHistory() {
  const list = document.getElementById("historyList");
  if (!list) return;
  list.innerHTML = "";
  if (!visitHistory.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px">No history yet</div>';
    return;
  }
  visitHistory.forEach((item) => {
    const row = document.createElement("div");
    row.className = "history-item";
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = item.title || item.url;
    a.title = item.url;
    a.onclick = (e) => {
      e.preventDefault();
      closeHistory();
      navigate(item.url);
    };
    const del = document.createElement("button");
    del.type = "button";
    del.innerHTML = '<img src="image/exit.svg" alt="Remove">';
    del.onclick = () => {
      visitHistory = visitHistory.filter((x) => x.id !== item.id);
      save();
      renderHistory();
    };
    row.appendChild(a);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function openHistory() {
  closeMenu();
  openPanel("historyPanel");
  renderHistory();
}

function closeHistory() {
  document.getElementById("historyPanel")?.classList.remove("open");
  document.getElementById("backdrop")?.classList.remove("open");
}


function createTab(newTab) {
  if (newTab === undefined) newTab = true;
  if (tabs.length >= MAX_TABS) return;
  const tab = {
    id: uid(), title: "New Tab", url: "", history: [], historyIndex: -1,
    newTab: true, engineFrame: null, favicon: FAVI, animOpen: true, lastActive: Date.now()
  };
  tabs.push(tab);
  activeTabId = tab.id;
  ensurePage(tab);
  showActiveOnly();
  renderChrome();
}
function closeTab(id) {
  const index = tabs.findIndex(t => t.id === id);
  if (index < 0) return;
  const el = document.querySelector('[data-tab-id="' + id + '"]');
  const finish = () => {
    const t = tabs[index];
    if (t && t.engineFrame) {
      try {
        const f = t.engineFrame.element || t.engineFrame.frame;
        if (f && f.remove) f.remove();
      } catch {}
      t.engineFrame = null;
    }
    tabs.splice(index, 1);
    prunePages();
    if (!tabs.length) { createTab(true); return; }
    if (activeTabId === id) activeTabId = tabs[Math.min(index, tabs.length - 1)].id;
    showActiveOnly();
    renderChrome();
  };
  if (el) { el.classList.add("closing"); setTimeout(finish, 160); }
  else finish();
}
function renameCurrentTab() {
  const p = getActiveTab();
  if (!p) return;
  closeMenu();
  const existing = document.querySelector(".modal-overlay.rename-modal");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay rename-modal";
  overlay.innerHTML =
    '<div class="modal-box">' +
    "<h2>Rename tab</h2>" +
    '<input class="text-input" id="renameInput" maxlength="64" value="' + escapeHTML(p.title || "") + '">' +
    '<div class="modal-actions">' +
    '<button class="modal-cancel" type="button">Cancel</button>' +
    '<button class="modal-go" type="button">Save</button>' +
    "</div></div>";
  document.body.appendChild(overlay);
  const input = overlay.querySelector("#renameInput");
  input.focus();
  input.select();
  const close = () => overlay.remove();
  overlay.querySelector(".modal-cancel").onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const saveName = () => {
    const name = input.value.trim();
    if (name) { p.title = name; renderTabs(); }
    close();
  };
  overlay.querySelector(".modal-go").onclick = saveName;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveName();
    if (e.key === "Escape") close();
  });
}
function goHome() {
  const p = getActiveTab();
  if (!p) { createTab(true); return; }
  if (p.engineFrame) {
    try {
      const f = p.engineFrame.element || p.engineFrame.frame;
      if (f && f.remove) f.remove();
    } catch {}
    p.engineFrame = null;
  }
  p.newTab = true; p.url = ""; p.title = "New Tab"; p.favicon = FAVI;
  p.history = []; p.historyIndex = -1;
  const wrapper = document.querySelector('.page[data-page-id="' + p.id + '"]');
  if (wrapper) { wrapper.innerHTML = homepageHTML(p.id); wireHome(wrapper, p); }
  renderChrome();
}
function toggleBookmark() {
  const p = getActiveTab();
  if (!p || !p.url) return;
  if (bookmarks.some(b => b.url === p.url)) bookmarks = bookmarks.filter(b => b.url !== p.url);
  else bookmarks.push({ id: uid(), title: p.title || p.url, url: p.url });
  save();
  renderToolbar();
  renderBookmarks();
}
function renderBookmarks() {
  const list = document.getElementById("bookmarkList");
  if (!bookmarks.length) { list.innerHTML = '<div class="empty">No bookmarks yet.</div>'; return; }
  list.innerHTML = bookmarks.map(b =>
    '<div class="bookmark-row"><div class="bookmark-main" data-open-bookmark="' + escapeHTML(b.url) + '">' +
    '<div class="bookmark-title">' + escapeHTML(b.title) + '</div>' +
    '<div class="bookmark-url">' + escapeHTML(b.url) + '</div></div>' +
    '<button class="bookmark-delete" data-delete-bookmark="' + escapeHTML(b.id) + '" type="button" aria-label="Remove" title="Remove"><img src="' + IMG + 'exit.svg" alt=""></button></div>'
  ).join("");
  list.querySelectorAll("[data-open-bookmark]").forEach(el =>
    el.onclick = () => { closePanels(); navigate(el.dataset.openBookmark); }
  );
  list.querySelectorAll("[data-delete-bookmark]").forEach(el =>
    el.onclick = () => {
      bookmarks = bookmarks.filter(b => b.id !== el.dataset.deleteBookmark);
      save(); renderBookmarks(); renderToolbar();
    }
  );
}

function openPanel(id) {
  closeMenu();
  document.getElementById("backdrop").classList.add("open");
  document.getElementById(id).classList.add("open");
  if (id === "settingsPanel") {
    try { fillWispSelect(); startLivePings(); } catch {}
  }
}
function closePanels() {
  try { closeHistory(); } catch {}
  return closePanelsInner();
}
function closePanelsInner() {
  document.getElementById("backdrop").classList.remove("open");
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("open"));
}
function closeMenu() { document.getElementById("mainMenu").classList.remove("open"); }

function safeColorValue(v, fallback) {
  const s = String(v || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  return fallback || "#101010";
}

function loadColorInputs() {
  try {
    const bg = document.getElementById("colorBg");
    if (bg) bg.value = safeColorValue(settings.bg || settings.newtab, "#101010");
    const panel = document.getElementById("colorPanel");
    if (panel) panel.value = safeColorValue(settings.panel, "#161616");
    const accent = document.getElementById("colorAccent");
    if (accent) accent.value = safeColorValue(settings.accent, "#ffffff");
    const text = document.getElementById("colorText");
    if (text) text.value = safeColorValue(settings.text, "#f0f0f0");
    const bgUrl = document.getElementById("backgroundUrl");
    if (bgUrl) bgUrl.value = settings.backgroundUrl || "";
  } catch (e) {
    console.warn("loadColorInputs", e);
  }
}
function loadCloakInputs() {
  try {
    const t = document.getElementById("cloakTitle");
    if (t) t.value = cloak.title || "";
    const i = document.getElementById("cloakIcon");
    if (i) i.value = cloak.icon || "";
  } catch (e) {}
}
function loadPanicInputs() {
  try {
    const k = document.getElementById("panicKey");
    if (k) k.value = panic.key ? ("Bound: " + panic.key) : "Not bound";
    const u = document.getElementById("panicUrl");
    if (u) u.value = panic.url || "";
  } catch (e) {}
}
function pingClass(ms, offline) {
  // 1-199 green, 200-499 orange, 500+ red, offline grey
  if (offline || ms == null || !Number.isFinite(ms)) return "ping-off";
  if (ms <= 199) return "ping-good";
  if (ms <= 499) return "ping-mid";
  return "ping-bad";
}

function pingWisp(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const start = performance.now();
    let ws;
    const done = (ms, offline) => {
      if (settled) return;
      settled = true;
      try { ws && ws.close(); } catch {}
      resolve({ ms, offline: !!offline });
    };
    try {
      if (!url || !/^wss?:\/\//i.test(url) || url.length < 12) {
        done(null, true);
        return;
      }
      ws = new WebSocket(url);
      ws.onopen = () => done(Math.round(performance.now() - start), false);
      ws.onerror = () => done(null, true);
      ws.onclose = () => { if (!settled) done(null, true); };
      setTimeout(() => done(null, true), timeoutMs);
    } catch {
      done(null, true);
    }
  });
}

function fillWispSelect() {
  const box = document.getElementById("serverList");
  if (!box) return;
  const servers = allWispServers();
  box.innerHTML = servers.map((s) => {
    const isSelected = settings.wispId === s.id;
    const sel = isSelected ? " selected" : "";
    // Pencil + X only when this custom server is selected; ping stays in the normal spot
    const actions = (s.custom && isSelected)
      ? '<span class="server-actions">' +
        '<span class="server-edit" data-edit="' + s.id + '" title="Rename"><img src="' + IMG + 'pencil.svg" alt=""></span>' +
        '<span class="server-del" data-del="' + s.id + '" title="Remove"><img src="' + IMG + 'exit.svg" alt=""></span>' +
        "</span>"
      : "";
    return (
      '<button type="button" class="server-row' + sel + '" data-server-id="' + s.id + '">' +
      '<span class="server-dot ping-wait" data-dot="' + s.id + '"><img src="' + IMG + 'status.svg" alt=""></span>' +
      '<span class="server-name">' + escapeHTML(s.name) + '</span>' +
      '<span class="server-ping" data-ping="' + s.id + '">...</span>' +
      actions +
      "</button>"
    );
  }).join("");

  box.querySelectorAll("[data-server-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (e.target.closest("[data-edit], [data-del]")) return;
      settings.wispId = btn.dataset.serverId;
      save();
      fillWispSelect();
      applyMuxTransport().catch(() => {});
      const st = document.getElementById("engineStatus");
      if (st) st.textContent = engineStatusReady();
    });
  });
  box.querySelectorAll("[data-edit]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.dataset.edit;
      const item = (settings.customServers || []).find((x) => x.id === id);
      if (!item) return;
      const name = prompt("Server name", item.name);
      if (name && name.trim()) {
        item.name = name.trim();
        save();
        fillWispSelect();
      }
    });
  });
  box.querySelectorAll("[data-del]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.dataset.del;
      settings.customServers = (settings.customServers || []).filter((x) => x.id !== id);
      if (settings.wispId === id) settings.wispId = "va1";
      save();
      fillWispSelect();
      applyMuxTransport().catch(() => {});
    });
  });

  updateServerPings();
}

let _pingTimer = null;
function updateServerPings() {
  const box = document.getElementById("serverList");
  if (!box) return;
  const servers = allWispServers();
  servers.forEach(async (s) => {
    const res = await pingWisp(s.url);
    const pingEl = box.querySelector('[data-ping="' + s.id + '"]');
    const dot = box.querySelector('[data-dot="' + s.id + '"]');
    if (!pingEl) return;
    pingEl.textContent = res.offline ? "offline" : (res.ms + " ms");
    pingEl.className = "server-ping " + pingClass(res.ms, res.offline);
    if (dot) dot.className = "server-dot " + pingClass(res.ms, res.offline);
  });
}
function startLivePings() {
  if (_pingTimer) clearInterval(_pingTimer);
  updateServerPings();
  _pingTimer = setInterval(updateServerPings, 12000);
}

const homeFxLoops = new WeakMap();

function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return { r: 122, g: 162, b: 255 };
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function stopHomeFx(wrapper) {
  const prev = homeFxLoops.get(wrapper);
  if (prev && prev.raf) cancelAnimationFrame(prev.raf);
  homeFxLoops.delete(wrapper);
}

function setupHomeFx(wrapper) {
  stopHomeFx(wrapper);
  const canvas = wrapper.querySelector("[data-home-fx]");
  if (!canvas) return;
  if (!settings.animEnabled || !COOKIE.consent) {
    canvas.style.display = "none";
    return;
  }
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d");
  const state = { raf: 0, t: 0, particles: [], bolts: [], flash: 0 };
  const resize = () => {
    const r = wrapper.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(r.width * (window.devicePixelRatio || 1)));
    canvas.height = Math.max(1, Math.floor(r.height * (window.devicePixelRatio || 1)));
    canvas.style.width = r.width + "px";
    canvas.style.height = r.height + "px";
  };
  resize();
  let style = settings.animStyle || "orbs";
  if (style === "waves" || style === "pulse") style = "rain";
  const sizeMul = Math.max(0.4, Math.min(2.5, Number(settings.animSize) || 1));
  let n = Number(settings.animCount);
  if (!Number.isFinite(n)) n = 18;
  n = Math.max(4, Math.min(80, Math.round(n)));
  if (style === "stars") n = Math.max(n, 12);
  if (style === "rain") n = Math.max(20, Math.min(120, Math.round(n * 1.4)));
  state.shooters = [];
  state.clouds = [];

  if (style === "rain") {
    // Diagonal rain (top-left → bottom-right), varied length/opacity
    for (let i = 0; i < n; i++) {
      state.particles.push({
        x: Math.random() * 1.3 - 0.15,
        y: Math.random() * 1.2 - 0.1,
        len: (0.035 + Math.random() * 0.07) * sizeMul,
        spd: 0.006 + Math.random() * 0.012,
        thick: 0.9 + Math.random() * 1.6,
        alpha: 0.25 + Math.random() * 0.55,
        // strong diagonal: down + to the right (like reference)
        ang: 0.45 + Math.random() * 0.25
      });
    }
    // Random organic clouds: varied blob count, size, darkness
    const cloudN = Math.max(4, Math.min(12, Math.round(n / 8) + 3));
    for (let i = 0; i < cloudN; i++) {
      const blobs = 4 + Math.floor(Math.random() * 5);
      const parts = [];
      for (let b = 0; b < blobs; b++) {
        parts.push({
          ox: (Math.random() - 0.5) * 0.9,
          oy: (Math.random() - 0.5) * 0.55,
          rx: 0.22 + Math.random() * 0.55,
          ry: 0.35 + Math.random() * 0.55
        });
      }
      state.clouds.push({
        x: Math.random() * 1.1 - 0.05,
        y: 0.02 + Math.random() * 0.28,
        w: 0.16 + Math.random() * 0.32,
        h: 0.05 + Math.random() * 0.09,
        spd: 0.00008 + Math.random() * 0.00022,
        dark: 0.08 + Math.random() * 0.28,
        parts
      });
    }
    } else {
    for (let i = 0; i < n; i++) {
      const isStars = style === "stars";
      state.particles.push({
        x: Math.random(), y: Math.random(),
        r: isStars ? (0.4 + Math.random() * 1.6) : ((0.015 + Math.random() * 0.07) * sizeMul),
        vx: isStars ? 0 : (Math.random() - 0.5) * 0.0004,
        vy: isStars ? 0 : (Math.random() - 0.5) * 0.00035,
        phase: Math.random() * Math.PI * 2,
        tw: Math.random() * Math.PI * 2
      });
    }
  }

  const spawnBolt = (w, h) => {
    const segs = [];
    let x = (0.15 + Math.random() * 0.7) * w;
    let y = 0;
    const targetY = h * (0.35 + Math.random() * 0.4);
    while (y < targetY) {
      const nx = x + (Math.random() - 0.5) * 28 * sizeMul;
      const ny = y + 12 + Math.random() * 22;
      segs.push({ x, y, nx, ny });
      x = nx;
      y = ny;
    }
    state.bolts.push({ segs, life: 1, branch: Math.random() > 0.55 });
    state.flash = 0.55 + Math.random() * 0.35;
  };

  const draw = () => {
    if (!settings.animEnabled) return;
    // Base speed scale so 1x is calm (was too fast before)
    const speed = (Number(settings.animSpeed) || 1) * 0.42;
    state.t += 0.016 * speed;
    const w = canvas.width, h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, w, h);
    const a = hexToRgb(settings.animColorA);
    const b = hexToRgb(settings.animColorB);

    if (style === "rain") {
      // Soft storm sky
      const sky = ctx.createLinearGradient(0, 0, 0, h * 0.55);
      sky.addColorStop(0, "rgba(" + a.r + "," + a.g + "," + a.b + ",0.1)");
      sky.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h * 0.55);

      // Organic multi-blob clouds (random shape / size / darkness)
      state.clouds.forEach((c) => {
        c.x += c.spd * speed;
        if (c.x > 1.25) c.x = -0.35;
        const cx = c.x * w;
        const cy = c.y * h;
        const cw = c.w * w;
        const ch = c.h * h;
        const shade = Math.floor(40 + c.dark * 90);
        ctx.fillStyle = "rgba(" + shade + "," + shade + "," + Math.min(255, shade + 12) + "," + (0.35 + c.dark) + ")";
        ctx.beginPath();
        (c.parts || []).forEach((p) => {
          ctx.ellipse(
            cx + p.ox * cw,
            cy + p.oy * ch,
            Math.max(4, p.rx * cw * 0.55),
            Math.max(3, p.ry * ch * 0.7),
            0, 0, Math.PI * 2
          );
        });
        ctx.fill();
      });

      // Thunder / lightning (kept)
      if (Math.random() < 0.0022 * speed) spawnBolt(w, h);
      if (state.flash > 0) {
        ctx.fillStyle = "rgba(200,215,255," + (state.flash * 0.2) + ")";
        ctx.fillRect(0, 0, w, h);
        state.flash *= 0.88;
        if (state.flash < 0.02) state.flash = 0;
      }
      state.bolts = state.bolts.filter((bolt) => {
        bolt.life -= 0.06 * (speed / 0.42);
        if (bolt.life <= 0) return false;
        ctx.strokeStyle = "rgba(210,225,255," + (0.55 * bolt.life) + ")";
        ctx.lineWidth = Math.max(1, 1.6 * sizeMul * dpr);
        ctx.lineCap = "round";
        ctx.beginPath();
        bolt.segs.forEach((s, i) => {
          if (i === 0) ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.nx, s.ny);
        });
        ctx.stroke();
        if (bolt.branch && bolt.segs.length > 3) {
          const mid = bolt.segs[Math.floor(bolt.segs.length / 2)];
          ctx.beginPath();
          ctx.moveTo(mid.x, mid.y);
          ctx.lineTo(mid.x + 20 * sizeMul, mid.y + 28 * sizeMul);
          ctx.stroke();
        }
        return true;
      });

      // Diagonal rain streaks — slanted down-right like the reference
      ctx.lineCap = "round";
      state.particles.forEach((p) => {
        // angle from vertical (~25–40°), positive = to the right while falling
        const tilt = p.ang; // ~0.55 rad
        const step = (0.01 + p.spd) * speed * 1.1;
        p.x += Math.sin(tilt) * step;
        p.y += Math.cos(tilt * 0.15) * step * 1.35;
        if (p.y > 1.12 || p.x > 1.25) {
          p.x = Math.random() * 1.15 - 0.25;
          p.y = -0.1 - Math.random() * 0.2;
        }
        const x0 = p.x * w;
        const y0 = p.y * h;
        const streak = p.len * Math.min(w, h) * 1.15;
        // draw along same diagonal (down + right)
        const x1 = x0 + Math.sin(tilt) * streak;
        const y1 = y0 + Math.cos(tilt * 0.2) * streak * 0.95;
        ctx.strokeStyle = "rgba(" + a.r + "," + a.g + "," + a.b + "," + p.alpha + ")";
        ctx.lineWidth = Math.max(0.85, p.thick * sizeMul * dpr * 0.5);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      });
        } else if (style === "stars") {
      // Fixed night-sky stars + rare shooting stars
      state.particles.forEach((p) => {
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(state.t * 1.4 + p.tw));
        ctx.fillStyle = "rgba(" + a.r + "," + a.g + "," + a.b + "," + tw + ")";
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, p.r * sizeMul * dpr * 0.5, 0, Math.PI * 2);
        ctx.fill();
      });
      if (Math.random() < 0.008 * speed) {
        state.shooters.push({
          x: Math.random(), y: Math.random() * 0.4,
          vx: 0.008 + Math.random() * 0.01,
          vy: 0.004 + Math.random() * 0.006,
          life: 1
        });
      }
      state.shooters = state.shooters.filter((s) => {
        s.x += s.vx * speed; s.y += s.vy * speed; s.life -= 0.02 * speed;
        if (s.life <= 0) return false;
        const x0 = s.x * w, y0 = s.y * h;
        const x1 = (s.x - s.vx * 4) * w, y1 = (s.y - s.vy * 4) * h;
        const grd = ctx.createLinearGradient(x0, y0, x1, y1);
        grd.addColorStop(0, "rgba(" + a.r + "," + a.g + "," + a.b + "," + (0.7 * s.life) + ")");
        grd.addColorStop(1, "rgba(" + a.r + "," + a.g + "," + a.b + ",0)");
        ctx.strokeStyle = grd;
        ctx.lineWidth = Math.max(1, 1.4 * sizeMul * dpr);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x0, y0);
        ctx.stroke();
        return true;
      });
    } else if (style === "constellation") {
      const pts = state.particles;
      pts.forEach((p) => {
        p.x += p.vx * speed; p.y += p.vy * speed;
        if (p.x < 0 || p.x > 1) p.vx *= -1;
        if (p.y < 0 || p.y > 1) p.vy *= -1;
      });
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
          const d = Math.hypot(dx, dy);
          if (d < 0.18) {
            ctx.strokeStyle = "rgba(" + a.r + "," + a.g + "," + a.b + "," + (0.22 * (1 - d / 0.18)) + ")";
            ctx.beginPath();
            ctx.moveTo(pts[i].x * w, pts[i].y * h);
            ctx.lineTo(pts[j].x * w, pts[j].y * h);
            ctx.stroke();
          }
        }
      }
      pts.forEach((p) => {
        ctx.fillStyle = "rgba(" + b.r + "," + b.g + "," + b.b + ",0.85)";
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 2.2 * dpr, 0, Math.PI * 2);
        ctx.fill();
      });
    } else {
      // orbs (default)
      state.particles.forEach((p, i) => {
        p.x += p.vx * speed;
        p.y += p.vy * speed;
        if (p.x < -0.1) p.x = 1.1;
        if (p.x > 1.1) p.x = -0.1;
        if (p.y < -0.1) p.y = 1.1;
        if (p.y > 1.1) p.y = -0.1;
        const pulse = 0.55 + Math.sin(state.t * 1.2 + p.phase) * 0.35;
        const rad = p.r * Math.min(w, h) * pulse;
        const col = i % 2 ? a : b;
        const g = ctx.createRadialGradient(p.x * w, p.y * h, 0, p.x * w, p.y * h, rad);
        g.addColorStop(0, "rgba(" + col.r + "," + col.g + "," + col.b + ",0.35)");
        g.addColorStop(1, "rgba(" + col.r + "," + col.g + "," + col.b + ",0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, rad, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    state.raf = requestAnimationFrame(draw);
  };
  state.raf = requestAnimationFrame(draw);
  homeFxLoops.set(wrapper, state);
  const ro = new ResizeObserver(resize);
  ro.observe(wrapper);
}

function setSwitch(el, on) {
  if (!el) return;
  el.classList.toggle("on", !!on);
  el.setAttribute("aria-checked", on ? "true" : "false");
}

function refreshHomeFxAll() {
  document.querySelectorAll(".page").forEach((pageEl) => {
    const id = pageEl.dataset.pageId;
    const tab = tabs.find((x) => x.id === id);
    if (tab && tab.newTab) setupHomeFx(pageEl);
  });
}

function lockVeil() {
  closeMenu();
  if (!profile.password) {
    alert("Set a password on first-run sign up before locking.");
    return;
  }
  if (settings.lockUnload) {
    const ok = confirm("Lock and unload open pages? Unsaved page state may be lost.");
    if (!ok) return;
    tabs.forEach((tab) => {
      if (tab.engineFrame) {
        try {
          const f = tab.engineFrame.element || tab.engineFrame.frame;
          if (f && f.remove) f.remove();
        } catch {}
        tab.engineFrame = null;
      }
    });
  }
  const existing = document.querySelector(".lock-overlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.className = "lock-overlay";
  overlay.innerHTML =
    '<div class="lock-card">' +
    "<h2>Veil is locked</h2>" +
    "<p>Enter your password to continue.</p>" +
    '<div class="lock-err" id="lockErr"></div>' +
    '<input type="password" id="lockPass" placeholder="Password" autocomplete="current-password">' +
    '<button type="button" class="lock-go" id="lockGo">Unlock</button>' +
    "</div>";
  document.body.appendChild(overlay);
  const input = overlay.querySelector("#lockPass");
  const err = overlay.querySelector("#lockErr");
  input.focus();
  const tryUnlock = () => {
    if (input.value === profile.password) {
      overlay.remove();
      if (settings.lockUnload) {
        const tab = getActiveTab();
        if (tab && !tab.newTab && tab.url) {
          const pageEl = document.querySelector('.page[data-page-id="' + tab.id + '"]');
          if (pageEl && !tab.engineFrame) {
            pageEl.innerHTML = "";
            const frame = document.createElement("div");
            frame.style.cssText = "width:100%;height:100%";
            pageEl.appendChild(frame);
            createEngineFrame(tab, frame);
          }
        }
      }
      return;
    }
    err.textContent = "Wrong password.";
    input.value = "";
    input.focus();
  };
  overlay.querySelector("#lockGo").onclick = tryUnlock;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
}

function highlightTheme() {
  try {
    if (!settings.transport || (settings.transport !== "epoxy" && settings.transport !== "libcurl")) {
      settings.transport = "epoxy";
    }
    document.querySelectorAll("[data-theme]").forEach(b => b.classList.toggle("active", b.dataset.theme === settings.theme));
    const customCard = document.getElementById("customThemeCard");
    if (customCard) customCard.classList.toggle("active", settings.theme === "custom");
    const editor = document.getElementById("customColorCard");
    if (editor) editor.classList.toggle("open", settings.theme === "custom" || editor.classList.contains("force-open"));
    const ep = document.getElementById("transportEpoxy");
    const lc = document.getElementById("transportLibcurl");
    if (ep) ep.classList.toggle("active", settings.transport !== "libcurl");
    if (lc) lc.classList.toggle("active", settings.transport === "libcurl");
    const launchSel = document.getElementById("launchModeSelect");
    if (launchSel) launchSel.value = settings.launchMode === "auto" ? "auto" : "manual";
    setSwitch(document.getElementById("adblockSwitch"), settings.adBlocker !== false);
    setSwitch(document.getElementById("animEnabledSwitch"), !!settings.animEnabled);
    setSwitch(document.getElementById("lockUnloadSwitch"), !!settings.lockUnload);
    setSwitch(document.getElementById("time24Switch"), settings.timeFormat === "24");
    const animOpts = document.getElementById("animOpts");
    if (animOpts) animOpts.classList.toggle("enabled", !!settings.animEnabled);
    const range = document.getElementById("maxLoadedTabs");
    const rangeVal = document.getElementById("maxLoadedTabsVal");
    if (range) {
      range.value = String(maxLoaded());
      if (rangeVal) rangeVal.textContent = String(maxLoaded());
    }
    const engSel = document.getElementById("searchEngineSelect");
    if (engSel) {
      if (!SEARCH_ENGINES[settings.searchEngine]) settings.searchEngine = "duckduckgo";
      engSel.value = settings.searchEngine || "duckduckgo";
    }
    const style = document.getElementById("animStyle");
    if (style) style.value = settings.animStyle || "orbs";
    const speed = document.getElementById("animSpeed");
    const speedVal = document.getElementById("animSpeedVal");
    if (speed) {
      speed.value = String(settings.animSpeed || 1);
      if (speedVal) speedVal.textContent = Number(settings.animSpeed || 1).toFixed(2) + "x";
    }
    const ca = document.getElementById("animColorA");
    const cb = document.getElementById("animColorB");
    if (ca) ca.value = safeColorValue(settings.animColorA, "#7aa2ff");
    if (cb) cb.value = safeColorValue(settings.animColorB, "#b88cff");
    const ac = document.getElementById("animCount");
    const acv = document.getElementById("animCountVal");
    if (ac) {
      ac.value = String(settings.animCount || 18);
      if (acv) acv.textContent = String(settings.animCount || 18);
    }
    const asz = document.getElementById("animSize");
    const asv = document.getElementById("animSizeVal");
    if (asz) {
      asz.value = String(settings.animSize || 1);
      if (asv) asv.textContent = Number(settings.animSize || 1).toFixed(2) + "x";
    }
  } catch (e) {
    console.warn("highlightTheme", e);
  }
}

function pushAdblockToSW() {
  const on = settings.adBlocker !== false;
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "veil-adblock", enabled: on });
    }
  } catch {}
}

function applyTheme(name) {
  if (!THEMES[name]) return;
  const keep = { transport: settings.transport, wispId: settings.wispId, wispCustom: settings.wispCustom, launchMode: settings.launchMode, backgroundUrl: settings.backgroundUrl, adBlocker: settings.adBlocker, maxLoadedTabs: settings.maxLoadedTabs, searchEngine: settings.searchEngine, lockUnload: settings.lockUnload, animEnabled: settings.animEnabled, animStyle: settings.animStyle, animSpeed: settings.animSpeed, animColorA: settings.animColorA, animColorB: settings.animColorB, animCount: settings.animCount, animSize: settings.animSize, customServers: settings.customServers, wispId: settings.wispId, timeFormat: settings.timeFormat };
  settings = Object.assign({}, settings, THEMES[name], keep, { theme: name });
  const editor = document.getElementById("customColorCard");
  if (editor) editor.classList.remove("open", "force-open");
  applyCSSVariables(); save(); highlightTheme(); loadColorInputs(); applyNewTabBackground();
}
function applyCustomColors() {
  const bgEl = document.getElementById("colorBg");
  if (bgEl && bgEl.value) settings.bg = bgEl.value;
  const panelEl = document.getElementById("colorPanel");
  if (panelEl && panelEl.value) settings.panel = panelEl.value;
  const accentEl = document.getElementById("colorAccent");
  if (accentEl && accentEl.value) settings.accent = accentEl.value;
  const textEl = document.getElementById("colorText");
  if (textEl && textEl.value) settings.text = textEl.value;
  // Single-color custom editor: derive the rest from background
  if (!panelEl) {
    settings.panel = settings.bg;
    settings.panel2 = settings.bg;
    settings.bg2 = settings.bg;
    settings.bg3 = settings.bg;
  }
  if (!settings.accent) settings.accent = "#ffffff";
  if (!settings.text) settings.text = "#f0f0f0";
  settings.theme = "custom";
  settings.newtab = settings.bg;
  applyCSSVariables(); save(); highlightTheme();
}
function applyBackground() {
  const el = document.getElementById("backgroundUrl");
  if (el) settings.backgroundUrl = el.value.trim();
  save(); applyNewTabBackground();
}
function applyCloakPreset(id) {
  const p = resolveCloakPreset(id);
  if (!p) return;
  cloak = { title: p.title, icon: p.icon };
  document.title = cloak.title;
  const fav = document.getElementById("favicon");
  if (fav) fav.href = cloak.icon;
  syncAboutBlankChrome();
  loadCloakInputs();
  save();
}
function applyCloak() {
  cloak.title = document.getElementById("cloakTitle").value.trim() || "Veil";
  cloak.icon = document.getElementById("cloakIcon").value.trim() || FAVI;
  document.title = cloak.title;
  document.getElementById("favicon").href = cloak.icon;
  syncAboutBlankChrome();
  save();
}
function resetSettings() {
  settings = Object.assign({}, DEFAULT_SETTINGS);
  panic = Object.assign({}, DEFAULT_PANIC);
  cloak = { title: "Veil", icon: FAVI };
  document.title = "Veil";
  document.getElementById("favicon").href = FAVI;
  applyCSSVariables(); save(); renderChrome(); applyNewTabBackground();
}

async function clearLocalData() {
  const ok = confirm("Clear all Veil cookies, local storage, and cache for this site?\n\nYou will be signed out.");
  if (!ok) return;
  try {
    if (window.VeilAccess && typeof window.VeilAccess.signOut === "function") {
      window.VeilAccess.signOut();
    }
  } catch (e) {}
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.indexOf("veil") === 0 || k.indexOf("veil_") === 0)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch (e) {}
  try {
    const cookies = document.cookie.split(";");
    cookies.forEach((c) => {
      const name = c.split("=")[0].trim();
      if (!name) return;
      if (name.indexOf("veil") !== -1 || name.indexOf("veil_") === 0) {
        document.cookie = name + "=; path=/; max-age=0; SameSite=Lax";
        document.cookie = name + "=; path=" + (typeof BASE !== "undefined" && BASE ? BASE + "/" : "/") + "; max-age=0; SameSite=Lax";
      }
    });
  } catch (e) {}
  try {
    if (caches && caches.keys) {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    }
  } catch (e) {}
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (e) {}
  location.reload();
}

async function setTransport(kind) {
  settings.transport = kind === "libcurl" ? "libcurl" : "epoxy";
  save(); highlightTheme();
  const st1 = document.getElementById("engineStatus");
  if (st1) st1.textContent = "Switching engine...";
  try {
    await applyMuxTransport();
    if (st1) st1.textContent = engineStatusReady();
  } catch (e) {
    console.warn(e);
    if (st1) st1.textContent = "Engine switch failed - try the other one";
  }
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}
document.getElementById("bindPanic").onclick = () => {
  bindingPanic = true;
  document.getElementById("panicKey").value = "Press any key...";
  document.getElementById("panicKey").focus();
};
document.getElementById("unbindPanic").onclick = () => {
  panic = { key: "", code: "", url: document.getElementById("panicUrl").value.trim() || DEFAULT_PANIC.url };
  save(); loadPanicInputs();
};
document.addEventListener("keydown", e => {
  if (bindingPanic) {
    e.preventDefault(); e.stopPropagation();
    bindingPanic = false;
    if (e.key === "Escape") { loadPanicInputs(); return; }
    panic.key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    panic.code = e.code;
    panic.url = document.getElementById("panicUrl").value.trim() || DEFAULT_PANIC.url;
    save(); loadPanicInputs();
    return;
  }
  if (!panic.code) return;
  if (isTypingTarget(e.target)) return;
  if (e.code === panic.code || e.key === panic.key || (panic.key && e.key.toUpperCase() === panic.key)) {
    e.preventDefault();
    location.replace(panic.url || DEFAULT_PANIC.url);
  }
}, true);

function isInsideAboutBlank() {
  try {
    if (sessionStorage.getItem("veil_in_ab") === "1") return true;
  } catch {}
  try {
    if (new URLSearchParams(location.search).get("ab") === "1") return true;
  } catch {}
  try {
    if (window.parent && window.parent !== window) {
      try {
        if (String(window.parent.location.href || "").startsWith("about:")) return true;
      } catch {
        // cross-origin parent - if we were opened with ?ab=1 we're already covered
      }
    }
  } catch {}
  return false;
}

function markAboutBlankSession() {
  try {
    if (new URLSearchParams(location.search).get("ab") === "1") {
      sessionStorage.setItem("veil_in_ab", "1");
    }
  } catch {}
}

/** RetroPixel-style about:blank shell - full viewport, no scrollbar, school-filter friendly */

function toggleEruda() {
  closeMenu();
  const p = getActiveTab();
  if (!p || p.newTab) return;
  const frameObj = p.engineFrame;
  if (!frameObj) {
    alert("Open a site first.");
    return;
  }
  const win = (frameObj.element || frameObj.frame || frameObj).contentWindow;
  if (!win) {
    alert("Page not ready yet.");
    return;
  }
  try {
    if (win.eruda) {
      win.eruda.show();
      return;
    }
    const script = win.document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/eruda";
    script.onload = () => {
      try {
        win.eruda.init();
        win.eruda.show();
      } catch (e) { console.warn(e); }
    };
    win.document.documentElement.appendChild(script);
  } catch (err) {
    console.warn(err);
    alert("DevTools unavailable for this page.");
  }
}

function updateDevtoolsMenuState() {
  const btn = document.getElementById("menuDevtools");
  if (!btn) return;
  const p = getActiveTab();
  const disabled = !p || !!p.newTab;
  btn.classList.toggle("disabled", disabled);
  btn.setAttribute("aria-disabled", disabled ? "true" : "false");
}


function syncAboutBlankChrome() {
  const title = (cloak && cloak.title) || "Veil";
  const icon = absFaviconUrl((cloak && cloak.icon) || FAVI);
  try {
    document.title = title;
    const fav = document.getElementById("favicon");
    if (fav) fav.href = icon;
  } catch {}
  // Parent about:blank shell (iframe case) — cloak can overwrite title/icon
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "veil-chrome", title: title, icon: icon }, "*");
    }
  } catch {}
  try {
    if (window.top && window.top !== window) {
      window.top.postMessage({ type: "veil-chrome", title: title, icon: icon }, "*");
    }
  } catch {}
}


function absFaviconUrl(icon) {
  let abIcon = icon || FAVI;
  try {
    if (abIcon.startsWith("data:") || /^https?:\/\//i.test(abIcon)) return abIcon;
    if (abIcon.startsWith("//")) return location.protocol + abIcon;
    if (abIcon.startsWith("/")) return location.origin + abIcon;
    return location.origin + REPO_PATH + String(abIcon).replace(/^\.\//, "");
  } catch {
    return location.origin + REPO_PATH + "image/favi.png";
  }
}

function openAboutBlank(kind) {
  if (isInsideAboutBlank()) {
    console.info("[veil] already inside about:blank - skip");
    return;
  }
  const appUrl = location.origin + REPO_PATH + (REPO_PATH.endsWith("/") ? "" : "/") + "?ab=1";
  // Always start as Veil; tab cloak overwrites via postMessage({ type: "veil-chrome" })
  const abTitle = "Veil";
  const abIcon = absFaviconUrl(FAVI);
  const shell = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>${abTitle}</title>
<link rel="icon" id="veil-ab-icon" href="${abIcon.replace(/"/g, "")}">
<style>
html, body {
  margin: 0; padding: 0; width: 100%; height: 100%;
  overflow: hidden; background: #000;
}
iframe {
  position: fixed; top: 0; left: 0;
  width: 100vw; height: 100vh;
  border: none; margin: 0; padding: 0;
  display: block; background: #000;
}
</style>
</head>
<body>
<iframe id="veilFrame" src="${appUrl}" allow="fullscreen; clipboard-read; clipboard-write"></iframe>
<script>
window.addEventListener("message", function (e) {
  if (!e.data || e.data.type !== "veil-chrome") return;
  try {
    if (e.data.title) document.title = e.data.title;
    if (e.data.icon) {
      var link = document.getElementById("veil-ab-icon") || document.querySelector("link[rel~='icon']") || document.createElement("link");
      link.id = "veil-ab-icon";
      link.rel = "icon";
      link.href = e.data.icon;
      if (!link.parentNode) document.head.appendChild(link);
    }
  } catch (err) {}
});
</script>
</body>
</html>`;

  let w;
  if (kind === "window") {
    w = window.open("", "", "width=1100,height=700,resizable=yes");
  } else {
    w = window.open("about:blank");
  }
  if (!w) {
    alert("Popup blocked - allow popups for this site.");
    return;
  }
  try {
    w.document.open();
    w.document.write(shell);
    w.document.close();
    setTimeout(syncAboutBlankChrome, 50);
    setTimeout(syncAboutBlankChrome, 400);
    // Avoid two open app tabs: leave this original tab on a neutral page
    if (kind !== "window") {
      setTimeout(function () {
        try {
          if (w && !w.closed) {
            location.replace("about:blank");
          }
        } catch (e) {}
      }, 250);
    }
  } catch (err) {
    console.error(err);
    alert("Could not write about:blank shell.");
  }
}

function openLaunchModal() {
  closeMenu();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML =
    '<div class="modal-box">' +
    "<h2>How would you like to launch?</h2>" +
    "<p>Open Veil inside about:blank so the real URL is hidden.</p>" +
    '<select id="launchKind" class="text-input">' +
    '<option value="tab">New about:blank tab</option>' +
    '<option value="window">New about:blank window</option>' +
    "</select>" +
    '<div class="modal-actions">' +
    '<button class="modal-cancel" type="button">Cancel</button>' +
    '<button class="modal-go" type="button">Launch</button>' +
    "</div></div>";
  document.body.appendChild(overlay);
  overlay.querySelector(".modal-cancel").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector(".modal-go").onclick = () => {
    const kind = overlay.querySelector("#launchKind").value;
    overlay.remove();
    openAboutBlank(kind === "window" ? "window" : "tab");
  };
}

function on(id, fn) {
  const el = document.getElementById(id);
  if (el) el.onclick = fn;
}

on("backBtn", goBack);
on("forwardBtn", goForward);
on("refreshBtn", reload);
on("homeBtn", goHome);
on("settingsOpenBtn", () => openPanel("settingsPanel"));
on("bookmarkBtn", toggleBookmark);
document.getElementById("address").addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    navigate(e.target.value);
  }
});
on("menuBtn", e => { e.stopPropagation(); updateDevtoolsMenuState(); document.getElementById("mainMenu")?.classList.toggle("open"); });
on("menuRename", () => { closeMenu(); renameCurrentTab(); });
on("menuLock", () => lockVeil());
on("menuHistory", () => { openHistory(); });
on("menuBookmarks", () => { closeMenu(); openPanel("bookmarksPanel"); });
on("menuDevtools", () => toggleEruda());
const launchNowBtn = document.getElementById("launchNowBtn");
if (launchNowBtn) launchNowBtn.onclick = () => openLaunchModal();
const searchEngineSelect = document.getElementById("searchEngineSelect");
if (searchEngineSelect) {
  searchEngineSelect.addEventListener("change", () => {
    const v = searchEngineSelect.value || "duckduckgo";
    settings.searchEngine = SEARCH_ENGINES[v] ? v : "duckduckgo";
    save();
  });
}
on("adblockSwitch", () => {
  settings.adBlocker = !(settings.adBlocker !== false);
  save(); highlightTheme(); pushAdblockToSW();
});
const launchModeSelect = document.getElementById("launchModeSelect");
if (launchModeSelect) {
  launchModeSelect.addEventListener("change", () => {
    settings.launchMode = launchModeSelect.value === "auto" ? "auto" : "manual";
    save();
  });
}
on("animEnabledSwitch", () => {
  if (!COOKIE.consent) {
    settings.animEnabled = false;
    highlightTheme();
    refreshHomeFxAll();
    return;
  }
  settings.animEnabled = !settings.animEnabled;
  save(); highlightTheme(); refreshHomeFxAll();
});
on("lockUnloadSwitch", () => {
  settings.lockUnload = !settings.lockUnload;
  save(); highlightTheme();
});
on("time24Switch", () => {
  settings.timeFormat = settings.timeFormat === "24" ? "12" : "24";
  save(); highlightTheme(); startWelcomeClock();
});
const animStyle = document.getElementById("animStyle");
if (animStyle) animStyle.addEventListener("change", () => {
  settings.animStyle = animStyle.value; save(); refreshHomeFxAll();
});
const animSpeed = document.getElementById("animSpeed");
if (animSpeed) {
  animSpeed.addEventListener("input", () => {
    settings.animSpeed = Number(animSpeed.value) || 1;
    const v = document.getElementById("animSpeedVal");
    if (v) v.textContent = Number(settings.animSpeed).toFixed(2) + "x";
  });
  animSpeed.addEventListener("change", () => {
    settings.animSpeed = Number(animSpeed.value) || 1;
    save(); refreshHomeFxAll();
  });
}
const animCount = document.getElementById("animCount");
if (animCount) {
  animCount.addEventListener("input", () => {
    settings.animCount = Number(animCount.value) || 18;
    const v = document.getElementById("animCountVal");
    if (v) v.textContent = String(settings.animCount);
  });
  animCount.addEventListener("change", () => {
    settings.animCount = Math.max(4, Math.min(80, Number(animCount.value) || 18));
    save(); refreshHomeFxAll();
  });
}
const animSize = document.getElementById("animSize");
if (animSize) {
  animSize.addEventListener("input", () => {
    settings.animSize = Number(animSize.value) || 1;
    const v = document.getElementById("animSizeVal");
    if (v) v.textContent = Number(settings.animSize).toFixed(2) + "x";
  });
  animSize.addEventListener("change", () => {
    settings.animSize = Number(animSize.value) || 1;
    save(); refreshHomeFxAll();
  });
}
document.getElementById("addCustomServer")?.addEventListener("click", () => {
  const name = (document.getElementById("customServerName")?.value || "").trim() || "Custom";
  let url = (document.getElementById("customServerUrl")?.value || "").trim();
  if (!url) { alert("Enter a server address (wss://...)"); return; }
  url = url.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  if (!/^wss?:\/\//i.test(url)) url = "wss://" + url;
  if (!url.endsWith("/")) url += "/";
  if (!settings.customServers) settings.customServers = [];
  const id = "c_" + Date.now().toString(36);
  settings.customServers.push({ id, name, url, custom: true });
  settings.wispId = id;
  save();
  document.getElementById("customServerName").value = "";
  document.getElementById("customServerUrl").value = "";
  fillWispSelect();
  applyMuxTransport().catch(() => {});
});
["animColorA", "animColorB"].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => {
    settings[id] = el.value;
    refreshHomeFxAll();
  });
  el.addEventListener("change", () => {
    settings[id] = el.value;
    save();
    refreshHomeFxAll();
  });
});
const maxRange = document.getElementById("maxLoadedTabs");
if (maxRange) {
  maxRange.addEventListener("input", () => {
    settings.maxLoadedTabs = Number(maxRange.value) || 8;
    const v = document.getElementById("maxLoadedTabsVal");
    if (v) v.textContent = String(settings.maxLoadedTabs);
  });
  maxRange.addEventListener("change", () => {
    settings.maxLoadedTabs = Math.min(20, Math.max(1, Number(maxRange.value) || 8));
    save();
    highlightTheme();
    showActiveOnly();
  });
}

on("saveUsername", () => {
  const name = (document.getElementById("newUsername")?.value || "").trim();
  if (!name) { alert("Enter a name."); return; }
  profile.name = name;
  save();
  const el = document.getElementById("newUsername");
  if (el) el.value = "";
  startWelcomeClock();
  alert("Username updated.");
});
on("savePassword", () => {
  const cur = document.getElementById("curPassword")?.value || "";
  const n1 = document.getElementById("newPassword")?.value || "";
  const n2 = document.getElementById("newPassword2")?.value || "";
  const msg = document.getElementById("passwordMsg");
  const setMsg = (m, bad) => { if (msg) { msg.textContent = m; msg.style.color = bad ? "var(--danger)" : "var(--muted)"; } };
  if (!profile.password) {
    setMsg("No password set yet. Use sign-up first.", true);
    return;
  }
  if (cur !== profile.password) {
    setMsg("Current password is incorrect.", true);
    return;
  }
  if (n1.length < 3) {
    setMsg("New password is too short.", true);
    return;
  }
  if (n1 !== n2) {
    setMsg("New passwords do not match.", true);
    return;
  }
  profile.password = n1;
  save();
  ["curPassword", "newPassword", "newPassword2"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  setMsg("Password updated.", false);
});

on("backdrop", closePanels);
document.querySelectorAll("[data-close-panel]").forEach(b => { b.onclick = closePanels; });
document.querySelectorAll("[data-theme]").forEach(b => { b.onclick = () => applyTheme(b.dataset.theme); });
on("customThemeCard", () => {
  const editor = document.getElementById("customColorCard");
  if (!editor) return;
  editor.classList.toggle("open");
  editor.classList.toggle("force-open", editor.classList.contains("open"));
  document.getElementById("customThemeCard")?.classList.add("active");
});
on("applyColors", applyCustomColors);
on("transportEpoxy", () => setTransport("epoxy"));
on("transportLibcurl", () => setTransport("libcurl"));
on("applyBackground", applyBackground);
on("applyCloak", applyCloak);
on("resetSettings", resetSettings);
on("clearLocalData", () => { clearLocalData(); });
document.getElementById("clearHistory")?.addEventListener("click", async () => {
  const ok = await veilConfirm("Clear history", "Are you sure you want to clear all history?");
  if (!ok) return;
  visitHistory = [];
  save();
  renderHistory();
});
document.addEventListener("click", (e) => {
  if (e.target.closest("#historyPanel") || e.target.closest("#menuHistory")) return;
  if (document.getElementById("historyPanel")?.classList.contains("open")) closeHistory();
});
const cloakPresetSelect = document.getElementById("cloakPresetSelect");
if (cloakPresetSelect) {
  cloakPresetSelect.addEventListener("change", () => {
    const id = cloakPresetSelect.value;
    if (!id) return;
    applyCloakPreset(id);
  });
}
document.querySelectorAll("[data-cloak]").forEach(b => { b.onclick = () => applyCloakPreset(b.dataset.cloak); });
document.addEventListener("click", e => {
  if (!e.target.closest("#mainMenu") && !e.target.closest("#menuBtn")) closeMenu();
});
document.addEventListener("keydown", e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "l") { e.preventDefault(); document.getElementById("address").focus(); document.getElementById("address").select(); }
  if (mod && e.key.toLowerCase() === "t") { e.preventDefault(); createTab(true); }
  if (mod && e.key.toLowerCase() === "w") { e.preventDefault(); if (activeTabId) closeTab(activeTabId); }
  if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); toggleBookmark(); }
  if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goBack(); }
  if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goForward(); }
  if (mod && e.key.toLowerCase() === "r") { e.preventDefault(); reload(); }
});
window.addEventListener("beforeunload", () => { if (COOKIE.consent) save(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") reconnectTransport();
});

function hasProfileName() {
  try {
    loadProfile();
  } catch (e) {}
  return !!(profile && String(profile.name || "").trim());
}

function showCookieConsent() {
  return new Promise((resolve) => {
    let consent = null;
    try { consent = localStorage.getItem("veil_cookie_consent"); } catch (e) {}
    if (!consent) {
      try { consent = COOKIE.get("veil_cookie_consent"); } catch (e) {}
    }
    if (consent === "yes") {
      COOKIE.consent = true;
      loadSavedData();
      resolve(true);
      return;
    }
    if (consent === "no") {
      COOKIE.consent = false;
      resolve(false);
      return;
    }
    // Remove any stuck overlay so we always can show a fresh one
    try {
      const stuck = document.getElementById("veilCookieOverlay");
      if (stuck) stuck.remove();
    } catch (e) {}
    const overlay = document.createElement("div");
    overlay.id = "veilCookieOverlay";
    overlay.className = "cookie-overlay";
    overlay.style.cssText = "z-index:100001;display:flex";
    overlay.innerHTML = '<div class="cookie-box"><h2>Allow cookies?</h2><p>Veil uses cookies to save your theme, bookmarks, cloak, and settings on this device.</p><div class="cookie-buttons"><button class="cookie-no" id="cookieNo" type="button">No</button><button class="cookie-yes" id="cookieYes" type="button">Yes</button></div></div>';
    document.body.appendChild(overlay);
    document.getElementById("cookieYes").onclick = () => {
      COOKIE.consent = true;
      try { localStorage.setItem("veil_cookie_consent", "yes"); } catch (e) {}
      COOKIE.set("veil_cookie_consent", "yes");
      loadSavedData();
      save();
      overlay.remove();
      applyCSSVariables();
      document.title = cloak.title || "Veil";
      syncAboutBlankChrome();
      const fav = document.getElementById("favicon");
      if (fav) fav.href = cloak.icon || FAVI;
      resolve(true);
    };
    document.getElementById("cookieNo").onclick = () => {
      COOKIE.consent = false;
      try { localStorage.setItem("veil_cookie_consent", "no"); } catch (e) {}
      overlay.remove();
      resolve(false);
    };
  });
}

function showSignup() {
  return new Promise((resolve) => {
    if (hasProfileName()) {
      resolve(false);
      return;
    }
    try {
      document.querySelectorAll(".signup-overlay").forEach((el) => el.remove());
    } catch (e) {}
    const overlay = document.createElement("div");
    overlay.className = "signup-overlay";
    overlay.style.cssText = "z-index:100002;display:flex";
    overlay.innerHTML =
      '<div class="signup-card">' +
      "<h2>Welcome to Veil</h2>" +
      '<p class="signup-sub">Choose what we should call you, and a password for this device. Nothing leaves your browser until server auth is added.</p>' +
      "<label>Display name</label>" +
      '<input id="signupName" maxlength="32" placeholder="e.g. Alex" autocomplete="nickname">' +
      "<label>Password</label>" +
      '<input id="signupPass" type="password" maxlength="64" placeholder="At least 4 characters" autocomplete="new-password">' +
      '<div class="signup-err" id="signupErr"></div>' +
      '<button class="signup-go" type="button" id="signupGo">Continue</button>' +
      "</div>";
    document.body.appendChild(overlay);
    const nameEl = overlay.querySelector("#signupName");
    const passEl = overlay.querySelector("#signupPass");
    const err = overlay.querySelector("#signupErr");
    try { nameEl.focus(); } catch (e) {}
    const submit = () => {
      const name = nameEl.value.trim();
      const pass = passEl.value;
      if (name.length < 1) { err.textContent = "Enter a name."; return; }
      if (pass.length < 4) { err.textContent = "Password must be at least 4 characters."; return; }
      profile = { name: name, password: pass };
      saveProfile();
      overlay.remove();
      document.querySelectorAll(".page").forEach((pageEl) => {
        const id = pageEl.dataset.pageId;
        const tab = tabs.find((x) => x.id === id);
        if (tab && tab.newTab) {
          pageEl.innerHTML = homepageHTML(id);
          wireHome(pageEl, tab);
        }
      });
      resolve(true);
    };
    overlay.querySelector("#signupGo").onclick = submit;
    passEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") passEl.focus(); });
  });
}

function forceHomeTab() {
  tabs = (tabs || []).filter(Boolean);

  // Keep admin tabs; collapse extra empty "New Tab" homes into one
  const adminTabs = tabs.filter((t) => t.isAdmin);
  const withUrl = tabs.filter((t) => !t.isAdmin && t.url && !t.newTab);
  let home = tabs.find((t) => !t.isAdmin && t.newTab && !t.url) || tabs.find((t) => !t.isAdmin) || null;

  if (!home) {
    const tab = {
      id: uid(), title: "New Tab", url: "", history: [], historyIndex: -1,
      newTab: true, engineFrame: null, favicon: FAVI, animOpen: true, lastActive: Date.now(), isAdmin: false
    };
    home = tab;
  } else {
    home.newTab = true;
    home.url = "";
    home.title = "New Tab";
    home.favicon = FAVI;
    home.engineFrame = null;
    home.isAdmin = false;
  }

  // Exactly one home + any real pages + admin tabs (no duplicate empty homes)
  tabs = [home].concat(withUrl.filter((t) => t.id !== home.id)).concat(adminTabs.filter((t) => t.id !== home.id));
  activeTabId = home.id;
  home.lastActive = Date.now();

  const viewport = document.getElementById("viewport");
  if (!viewport) return home;

  // Remove orphan page shells that are not in tabs
  const keepIds = new Set(tabs.map((t) => t.id));
  viewport.querySelectorAll(".page").forEach((p) => {
    const id = p.dataset.pageId;
    if (id && !keepIds.has(id)) p.remove();
  });

  let wrap = viewport.querySelector('.page[data-page-id="' + home.id + '"]');
  if (!wrap) {
    wrap = document.createElement("section");
    wrap.className = "page";
    wrap.dataset.pageId = home.id;
    viewport.appendChild(wrap);
  }
  try {
    wrap.innerHTML = homepageHTML(home.id);
    wireHome(wrap, home);
  } catch (err) {
    console.error("home render", err);
    try {
      wrap.innerHTML = homepageHTML(home.id);
      wireHome(wrap, home);
    } catch (e2) {}
  }
  wrap.classList.add("active");
  wrap.style.display = "block";
  viewport.querySelectorAll(".page").forEach((p) => {
    if (p !== wrap) {
      p.classList.remove("active");
      p.style.display = "none";
    }
  });
  return home;
}


function formatAccessLeft(meta) {
  if (!meta) return "—";
  if (meta.infinite) return "Unlimited";
  if (meta.expires) {
    const ms = Number(meta.expires) - Date.now();
    if (ms <= 0) return "Expired";
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const parts = [];
    if (d) parts.push(d + "d");
    if (h) parts.push(h + "h");
    if (m) parts.push(m + "m");
    if (!d && !h) parts.push(sec + "s");
    else if (sec && parts.length < 2) parts.push(sec + "s");
    return parts.join(" ") || "0s";
  }
  return meta.timeLeft || "—";
}

function updateAccessTimeBar() {
  const bars = document.querySelectorAll("#timeBar, .time-bar");
  if (!bars.length) return;
  const meta = (window.VeilAccess && window.VeilAccess.getMeta && window.VeilAccess.getMeta()) || null;
  const text = "Time Remaining: " + formatAccessLeft(meta);
  bars.forEach((el) => { el.textContent = text; });
}

setInterval(updateAccessTimeBar, 1000);
window.addEventListener("veil-session-meta", updateAccessTimeBar);
window.addEventListener("veil-access-ok", updateAccessTimeBar);
// Admin ban / revoke while using Veil — gate handles UI; stop chrome updates
window.addEventListener("veil-access-revoked", function () {
  try {
    document.body.classList.add("gate-lock");
    const app = document.getElementById("browser") || document.getElementById("app");
    if (app) app.style.display = "none";
  } catch (e) {}
});


let __veilBootStarted = false;

async function bootVeilApp() {
  if (__veilBootStarted) return;
  __veilBootStarted = true;

  // Make sure the shell is visible (access gate may have left body locked)
  try {
    document.body.classList.remove("gate-lock");
    const appRoot = document.getElementById("browser") || document.getElementById("app");
    if (appRoot) appRoot.style.display = "";
    const gate = document.getElementById("accessGate");
    if (gate) gate.style.display = "none";
    const bl = document.getElementById("accessBlocked");
    if (bl) bl.style.display = "none";
  } catch (e) {}

  loadProfile();
  let consent = null;
  try { consent = localStorage.getItem("veil_cookie_consent"); } catch (e) {}
  if (!consent) {
    try { consent = COOKIE.get("veil_cookie_consent"); } catch (e) {}
  }
  if (consent === "yes") { COOKIE.consent = true; loadSavedData(); }

  if (!cloak.icon) cloak.icon = FAVI;
  cloak.title = cloak.title || "Veil";
  cloak.icon = cloak.icon || FAVI;
  applyCSSVariables();
  document.title = cloak.title;
  try {
    const fav = document.getElementById("favicon");
    if (fav) fav.href = cloak.icon;
  } catch (e) {}
  markAboutBlankSession();
  syncAboutBlankChrome();

  // Required order: cookies → signup → homepage
  try { await showCookieConsent(); } catch (e) { console.warn("cookie consent", e); }
  try { await showSignup(); } catch (e) { console.warn("signup", e); }

  // Always force a real home tab with content (fixes blank / guest-only shell)
  try {
    forceHomeTab();
  } catch (e) {
    console.error("forceHomeTab", e);
    try { createTab(true); } catch (e2) {}
  }

  showActiveOnly();
  renderChrome();
  startWelcomeClock();
  try { startLivePings(); } catch (e) {}
  // Engine loads on first navigation (saves memory)
  // initEngine().then(() => pushAdblockToSW()).catch(() => {});
  setTimeout(syncAboutBlankChrome, 100);
  setTimeout(syncAboutBlankChrome, 600);

  if (settings.theme && THEMES[settings.theme]) {
    Object.assign(settings, THEMES[settings.theme], {
      theme: settings.theme,
      transport: settings.transport,
      wispId: settings.wispId,
      launchMode: settings.launchMode,
      backgroundUrl: settings.backgroundUrl,
      adBlocker: settings.adBlocker,
      maxLoadedTabs: settings.maxLoadedTabs,
      searchEngine: settings.searchEngine,
      lockUnload: settings.lockUnload,
      animEnabled: settings.animEnabled,
      animStyle: settings.animStyle,
      animSpeed: settings.animSpeed,
      animCount: settings.animCount,
      animSize: settings.animSize,
      animColorA: settings.animColorA,
      animColorB: settings.animColorB,
      customServers: settings.customServers,
      timeFormat: settings.timeFormat
    });
  } else {
    settings.theme = "matte";
    Object.assign(settings, THEMES.matte, { theme: "matte" });
  }
  applyCSSVariables();
  try { highlightTheme(); } catch (e) {}

  // Safety net: homepage missing or zero tabs only — do not create a second home
  setTimeout(function () {
    try {
      const vp = document.getElementById("viewport");
      const hasHome = vp && vp.querySelector(".newtab-page");
      const emptyHomes = tabs.filter((t) => !t.isAdmin && t.newTab && !t.url);
      if (!tabs.length || !hasHome) {
        forceHomeTab();
      } else if (emptyHomes.length > 1) {
        forceHomeTab();
      }
      showActiveOnly();
      renderChrome();
    } catch (e) {}
  }, 200);
}

// Do not load browser until access gate passes
(function waitForAccess() {
  function start() {
    bootVeilApp().catch(function (err) {
      console.error("bootVeilApp failed", err);
      try { forceHomeTab(); renderChrome(); } catch (e) {}
    });
  }
  if (window.__VEIL_ACCESS_OK) {
    start();
    return;
  }
  window.addEventListener("veil-access-ok", function once() {
    window.removeEventListener("veil-access-ok", once);
    start();
  });
})();

on("signOutBtn", () => {
  closePanels();
  closeMenu();
  if (window.VeilAccess && typeof window.VeilAccess.signOut === "function") {
    window.VeilAccess.signOut();
  } else {
    try {
      localStorage.removeItem("veil_access_token");
      document.cookie = "veil_access_token=; path=/; max-age=0; SameSite=Lax";
    } catch (e) {}
    location.reload();
  }
});

on("openAdminPanel", () => {
  closePanels();
  closeMenu();
  try { closeHistory(); } catch {}
  const path = location.pathname.replace(/\/?index\.html$/i, "/").replace(/\/?$/, "/");
  const adminUrl = location.origin + path + "admin/index.html";
  // Prefer reusing existing Admin Panel tab
  let page = tabs.find((t) => t.isAdmin);
  if (!page) {
    if (tabs.length >= MAX_TABS) {
      alert("Too many tabs");
      return;
    }
    page = {
      id: uid(),
      title: "Admin Panel",
      url: adminUrl,
      history: [],
      historyIndex: -1,
      newTab: false,
      isAdmin: true,
      engineFrame: null,
      favicon: (typeof IMG !== "undefined" ? IMG : "image/") + "home.svg",
      animOpen: true,
      lastActive: Date.now()
    };
    tabs.push(page);
  } else {
    page.url = adminUrl;
    page.title = "Admin Panel";
    page.favicon = (typeof IMG !== "undefined" ? IMG : "image/") + "home.svg";
    page.lastActive = Date.now();
  }
  activeTabId = page.id;
  const viewport = document.getElementById("viewport");
  if (!viewport) return;
  let wrap = viewport.querySelector('.page[data-page-id="' + page.id + '"]');
  if (!wrap) {
    wrap = document.createElement("section");
    wrap.className = "page";
    wrap.dataset.pageId = page.id;
    viewport.appendChild(wrap);
  }
  wrap.innerHTML = "";
  const fr = document.createElement("iframe");
  fr.className = "engine-frame";
  fr.setAttribute("title", "Admin Panel");
  fr.style.cssText = "width:100%;height:100%;border:0;background:#101010";
  fr.src = adminUrl;
  wrap.appendChild(fr);
  page.engineFrame = { frame: fr, element: fr };
  showActiveOnly();
  renderChrome();
  const addr = document.getElementById("address");
  if (addr) addr.value = "Admin Panel";
});

