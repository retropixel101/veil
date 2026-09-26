/**
 * Veil access gate — email accounts + pending approval
 */
(function () {
  try {
    var q = new URLSearchParams(location.search);
    if (q.get("worker")) {
      localStorage.setItem("veil_worker_url", q.get("worker").replace(/\/$/, ""));
    }
  } catch (e) {}

  var WORKER_URL = (
    localStorage.getItem("veil_worker_url") ||
    "https://veil-access.retropixel404.workers.dev"
  ).replace(/\/$/, "");

  var SESSION_KEY = "veil_access_token";
  var SESSION_META = "veil_access_meta";
  var PENDING_EMAIL = "veil_pending_email";

  var gate = document.getElementById("accessGate");
  var appRoot = document.getElementById("browser") || document.getElementById("app");
  var keyMsg = document.getElementById("accessMsg");
  var gateBox = document.getElementById("gateAuthBox") || (gate && gate.querySelector(".box"));

  function readCookie(name) {
    try {
      var parts = document.cookie.split(";");
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        if (p.indexOf(encodeURIComponent(name) + "=") === 0) {
          return decodeURIComponent(p.slice(encodeURIComponent(name).length + 1));
        }
      }
    } catch (e) {}
    return "";
  }

  function writeCookie(name, value, maxAgeSec) {
    try {
      var age = maxAgeSec == null ? 60 * 60 * 24 * 400 : maxAgeSec;
      document.cookie =
        encodeURIComponent(name) + "=" + encodeURIComponent(value || "") +
        "; path=/; max-age=" + age + "; SameSite=Lax";
    } catch (e) {}
  }

  function clearCookie(name) {
    try {
      document.cookie = encodeURIComponent(name) + "=; path=/; max-age=0; SameSite=Lax";
    } catch (e) {}
  }

  function getToken() {
    try {
      return localStorage.getItem(SESSION_KEY) || readCookie(SESSION_KEY) || "";
    } catch (e) {
      return readCookie(SESSION_KEY) || "";
    }
  }

  var livePollTimer = null;
  var lastUser = null;

  function stopLivePoll() {
    if (livePollTimer) {
      clearInterval(livePollTimer);
      livePollTimer = null;
    }
  }

  function setToken(token, user) {
    try {
      if (token) localStorage.setItem(SESSION_KEY, token);
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
    if (!token) {
      clearCookie(SESSION_KEY);
      try { localStorage.removeItem(SESSION_META); } catch (e2) {}
      lastUser = null;
      stopLivePoll();
      return;
    }
    /* Keep pending/unverified sessions for a long time so refresh stays signed in */
    var maxAge = 60 * 60 * 24 * 400;
    if (user && user.hasAccess && !user.infinite && user.expires) {
      var left = Math.floor((Number(user.expires) - Date.now()) / 1000);
      if (left > 0) maxAge = Math.max(left, 60);
    }
    writeCookie(SESSION_KEY, token, maxAge);
    lastUser = user || null;
    try {
      localStorage.setItem(SESSION_META, JSON.stringify({
        email: user && user.email,
        expires: user && user.expires,
        infinite: user && user.infinite,
        status: user && user.status,
        remainingMs: user && user.remainingMs,
        remainingLabel: user && user.remainingLabel,
        hasAccess: user && user.hasAccess
      }));
    } catch (e) {}
    try {
      window.dispatchEvent(new CustomEvent("veil-session-meta", { detail: user }));
    } catch (e) {}
  }

  function clearToken() {
    setToken("", null);
    try { localStorage.removeItem(PENDING_EMAIL); } catch (e) {}
  }

  /** Ban / grant / expiry apply live without full page refresh */
  function startLivePoll() {
    stopLivePoll();
    livePollTimer = setInterval(function () {
      var token = getToken();
      if (!token) {
        stopLivePoll();
        return;
      }
      api("/api/session/check", { token: token }).then(function (r) {
        if (!r.data) return;
        if (r.data.ok && r.data.user && r.data.user.hasAccess) {
          setToken(token, r.data.user);
          return;
        }
        stopLivePoll();
        window.__VEIL_ACCESS_OK = false;
        window.__VEIL_UNLOCKING = false;
        handleAuthResult(r.data, token);
        try {
          window.dispatchEvent(new CustomEvent("veil-access-revoked", { detail: r.data }));
        } catch (e) {}
      });
    }, 12000);
  }

  function doSignOut() {
    var token = getToken();
    if (token) {
      api("/api/auth/logout", { token: token }).catch(function () {});
    }
    clearToken();
    stopLivePoll();
    stopPendingPoll();
    window.__VEIL_ACCESS_OK = false;
    window.__VEIL_UNLOCKING = false;
    try {
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.disableAutoSelect();
      }
    } catch (e) {}
    try {
      document.body.classList.add("gate-lock");
      if (appRoot) appRoot.style.display = "none";
    } catch (e) {}
    showGate(DEFAULT_MSG, false);
    showPanel("login");
  }

  window.VeilAccess = {
    getToken: getToken,
    signOut: doSignOut,
    getMeta: function () {
      try {
        return lastUser || JSON.parse(localStorage.getItem(SESSION_META) || "null");
      } catch (e) {
        return null;
      }
    },
    getUser: function () {
      return lastUser;
    },
    checkNow: function () {
      return checkSession();
    },
  };


  function closeChromeExtras() {
    try {
      /* Only clear open state — do not set inline display:none (breaks later openPanel) */
      document.querySelectorAll(".panel, #settingsPanel, #historyPanel, #bookmarksPanel").forEach(function (el) {
        el.classList.remove("open", "show");
        el.style.removeProperty("display");
      });
      var menu = document.getElementById("mainMenu") || document.getElementById("menu");
      if (menu) {
        menu.classList.remove("open");
        menu.style.removeProperty("display");
      }
      var bd = document.getElementById("backdrop");
      if (bd) {
        bd.classList.remove("show", "open");
        bd.style.removeProperty("display");
      }
    } catch (e) {}
  }

  /** Fade out / remove the initial #veilBoot cover (keeps chrome from flashing on gate). */
  function dismissBoot(immediate) {
    var bootEl = document.getElementById("veilBoot");
    if (!bootEl) return;
    /* Leave error state visible so the user can retry */
    if (bootEl.classList.contains("err") && !immediate) return;
    if (immediate) {
      try {
        if (bootEl.parentNode) bootEl.parentNode.removeChild(bootEl);
      } catch (e) {}
      return;
    }
    bootEl.classList.add("done");
    setTimeout(function () {
      try {
        if (bootEl.parentNode) bootEl.parentNode.removeChild(bootEl);
      } catch (e) {}
    }, 400);
  }

  function setBodyLocked(locked) {
    document.body.classList.toggle("gate-lock", !!locked);
    if (locked) closeChromeExtras();
  }

  function ensureBlockedLayer() {
    var el = document.getElementById("accessBlocked");
    if (el) return el;
    el = document.createElement("div");
    el.id = "accessBlocked";
    el.innerHTML =
      '<div class="blocked-panel">' +
      "<h2>You are blocked from entering Veil</h2>" +
      '<p class="blocked-time" id="blockedTimeMsg"></p>' +
      "</div>";
    document.body.appendChild(el);
    return el;
  }

  function showBlack() {
    setBodyLocked(true);
    if (appRoot) appRoot.style.display = "none";
    var bl = document.getElementById("accessBlocked");
    if (bl) bl.style.display = "none";
    if (gate) {
      gate.style.display = "flex";
      gate.classList.add("checking");
      gate.classList.remove("is-blocked");
    }
    if (gateBox) gateBox.style.visibility = "hidden";
    if (keyMsg) keyMsg.textContent = "";
  }

  var DEFAULT_MSG = "Sign in with your email to use Veil";

  function setMsg(msg, isErr, autoRestore) {
    if (!keyMsg) return;
    clearTimeout(keyMsg._t);
    keyMsg.textContent = msg || DEFAULT_MSG;
    keyMsg.style.color = isErr ? "#ff5c5c" : "#888888";
    if (autoRestore && isErr && msg) {
      keyMsg._t = setTimeout(function () {
        keyMsg.textContent = DEFAULT_MSG;
        keyMsg.style.color = "#888888";
      }, 4000);
    }
  }

  function showPanel(name) {
    document.querySelectorAll(".gate-panel").forEach(function (p) {
      p.classList.toggle("active", p.id === "panel" + name.charAt(0).toUpperCase() + name.slice(1));
    });
    // panels: login, signup, verify, pending
    var map = { login: "panelLogin", signup: "panelSignup", verify: "panelVerify", pending: "panelPending" };
    document.querySelectorAll(".gate-panel").forEach(function (p) {
      p.classList.remove("active");
    });
    var el = document.getElementById(map[name] || "panelLogin");
    if (el) el.classList.add("active");
    document.querySelectorAll("[data-gate-tab]").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-gate-tab") === name);
    });
    var tabs = document.querySelector(".gate-tabs");
    if (tabs) tabs.style.display = name === "login" || name === "signup" ? "flex" : "none";
    var sub = document.getElementById("gateSub");
    if (sub) {
      if (name === "pending") sub.textContent = "";
      else if (name === "verify") sub.textContent = "Check your inbox for a code";
      else sub.textContent = "Sign in to continue";
    }
  }

  function showGate(msg, isErr) {
    setBodyLocked(true);
    closeChromeExtras();
    if (appRoot) appRoot.style.display = "none";
    var bl = document.getElementById("accessBlocked");
    if (bl) bl.style.display = "none";
    if (gate) {
      gate.style.display = "flex";
      gate.classList.remove("checking", "is-blocked");
    }
    if (gateBox) gateBox.style.visibility = "visible";
    setMsg(msg || DEFAULT_MSG, !!isErr, !!isErr);
    /* Gate is painted — drop the boot cover so login/pending show without chrome flicker */
    dismissBoot(false);
  }

  var pendingPollTimer = null;

  function stopPendingPoll() {
    if (pendingPollTimer) {
      clearInterval(pendingPollTimer);
      pendingPollTimer = null;
    }
  }

  function startPendingPoll() {
    stopPendingPoll();
    pendingPollTimer = setInterval(function () {
      quietCheckAccess(true);
    }, 8000);
  }

  /** mode: "pending" | "expired" | "signed_out" */
  function showPending(user, mode) {
    stopLivePoll();
    window.__VEIL_ACCESS_OK = false;
    window.__VEIL_UNLOCKING = false;

    var email = (user && user.email) || "";
    try {
      if (email) localStorage.setItem(PENDING_EMAIL, email);
      else email = localStorage.getItem(PENDING_EMAIL) || "";
    } catch (e) {}

    var kind = mode || "pending";
    if (!mode && user) {
      if (user.status === "expired" || (user.hasAccess === false && user.status === "allowed")) {
        kind = "expired";
      } else if (user.status === "expired") {
        kind = "expired";
      }
    }

    showGate("", false);
    if (keyMsg) keyMsg.textContent = "";
    showPanel("pending");

    var title = document.getElementById("pendingTitle");
    var emailEl = document.getElementById("pendingEmail");
    var text = document.getElementById("pendingText");
    var hint = document.getElementById("pendingHint");
    var icon = document.querySelector("#panelPending .pending-icon");

    if (emailEl) emailEl.textContent = email || "";

    if (kind === "expired" || kind === "signed_out") {
      if (title) title.textContent = "Access paused";
      if (text) {
        text.textContent =
          "Your time on Veil has run out. Ask an admin to add more time, then tap Check status.";
      }
      if (hint) {
        hint.textContent = "Stay on this page — we’ll keep checking automatically.";
      }
      if (icon) { icon.className = "pending-icon status-wait"; }
    } else {
      if (title) title.textContent = "Almost there";
      if (text) {
        text.textContent =
          "Your account is ready. An admin still needs to approve you and add access time before you can browse.";
      }
      if (hint) {
        hint.textContent = "You can leave this open. We’ll check every few seconds and let you in when you’re approved.";
      }
      if (icon) { icon.className = "pending-icon status-wait"; }
    }

    startPendingPoll();
  }

  function quietCheckAccess(fromPoll) {
    var token = getToken();
    if (!token) {
      stopPendingPoll();
      return;
    }
    var btn = document.getElementById("pendingRefreshBtn");
    if (btn && !fromPoll) {
      btn.disabled = true;
      btn.textContent = "Checking…";
    }
    api("/api/session/check", { token: token }).then(function (r) {
      if (btn && !fromPoll) {
        btn.disabled = false;
        btn.textContent = "Check status";
      }
      if (!r.data) return;
      if (r.data.ok && r.data.user && r.data.user.hasAccess) {
        stopPendingPoll();
        setToken(token, r.data.user);
        unlockApp();
        return;
      }
      // Stay on waiting screen; refresh copy if status changed
      if (r.data.user || r.data.reason) {
        var mode = r.data.reason || (r.data.user && r.data.user.status) || "pending";
        if (mode === "banned") {
          stopPendingPoll();
          handleAuthResult(r.data, token);
          return;
        }
        showPending(r.data.user, mode === "signed_out" ? "expired" : mode);
      }
    });
  }

  function showBlocked(msg) {
    setBodyLocked(true);
    closeChromeExtras();
    if (appRoot) appRoot.style.display = "none";
    if (gate) {
      gate.style.display = "none";
    }
    var el = ensureBlockedLayer();
    el.style.display = "flex";
    var p = document.getElementById("blockedTimeMsg");
    if (p) p.textContent = msg || "Contact an admin if you think this is a mistake.";
    dismissBoot(false);
  }

  function ensureAppLoader() {
    var el = document.getElementById("veilAppLoad");
    if (el) {
      el.classList.remove("done");
      el.style.opacity = "1";
      el.style.visibility = "visible";
      el.style.display = "flex";
      return el;
    }
    el = document.createElement("div");
    el.id = "veilAppLoad";
    el.innerHTML =
      '<div class="boot-card">' +
      '<div class="boot-mark"><img src="image/favi.png" alt="" onerror="this.style.display=\'none\'"></div>' +
      '<div class="boot-title">Veil</div>' +
      '<div class="boot-sub" id="veilAppLoadSub">Loading browser…</div>' +
      '<div class="boot-bar"><i></i></div>' +
      "</div>";
    /* Styles also in CSS (#veilAppLoad); inline keeps it visible even if CSS lags */
    el.style.cssText =
      "position:fixed;inset:0;z-index:200000;display:flex;align-items:center;justify-content:center;" +
      "background:#0c0c0c;flex-direction:column;padding:28px;" +
      "transition:opacity .5s ease,visibility .5s ease;opacity:1;visibility:visible";
    document.body.appendChild(el);
    return el;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        resolve();
        return;
      }
      var s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error("Failed to load " + src));
      };
      document.body.appendChild(s);
    });
  }

  function unlockApp() {
    if (window.__VEIL_UNLOCKING || window.__VEIL_ACCESS_OK) return;
    window.__VEIL_UNLOCKING = true;
    stopPendingPoll();

    /* Show browser loader immediately on entry/refresh, then load engine */
    var loadStarted = Date.now();
    var loader = ensureAppLoader();
    dismissBoot(true);

    if (gate) gate.style.display = "none";
    var bl = document.getElementById("accessBlocked");
    if (bl) bl.style.display = "none";

    var sub = document.getElementById("veilAppLoadSub");
    function setLoadMsg(t) {
      if (sub) sub.textContent = t;
    }

    setLoadMsg("Loading browser…");
    startLivePoll();

    // Load engine + app only after the user is allowed in
    Promise.resolve()
      .then(function () {
        setLoadMsg("Loading connection…");
        return loadScript("baremux/index.js");
      })
      .then(function () {
        setLoadMsg("Loading engine…");
        return loadScript("scramjet/scramjet.all.js");
      })
      .then(function () {
        setLoadMsg("Starting Veil…");
        return loadScript("veil-app.js");
      })
      .then(function () {
        window.__VEIL_ACCESS_OK = true;
        setBodyLocked(false);
        if (appRoot) appRoot.style.display = "";
        document.body.classList.add("boot-reveal");
        try {
          window.dispatchEvent(new CustomEvent("veil-access-ok"));
        } catch (e) {}
        try {
          if (typeof window.__veilStartApp === "function") window.__veilStartApp();
          else if (typeof window.bootVeilApp === "function") window.bootVeilApp();
        } catch (e) {
          console.error(e);
        }
        /* Keep loader visible long enough for the animation to actually play */
        var minShow = 750;
        var elapsed = Date.now() - loadStarted;
        var waitMore = Math.max(0, minShow - elapsed);
        setTimeout(function () {
          if (loader) {
            loader.classList.add("done");
            loader.style.opacity = "0";
            loader.style.visibility = "hidden";
            setTimeout(function () {
              try {
                if (loader.parentNode) loader.parentNode.removeChild(loader);
              } catch (e) {}
            }, 500);
          }
          document.body.classList.remove("boot-reveal");
          window.__VEIL_UNLOCKING = false;
        }, waitMore + 350);
      })
      .catch(function (err) {
        window.__VEIL_UNLOCKING = false;
        setLoadMsg("Could not load Veil");
        if (loader) {
          loader.innerHTML =
            '<div class="boot-card"><div class="boot-title">Veil</div>' +
            '<div class="boot-error" style="display:block">' +
            "<h3>Couldn’t load the browser</h3>" +
            "<p>" +
            String((err && err.message) || err) +
            "</p>" +
            "<p>Email support: <a href=\"mailto:veilsupport01@gmail.com\">veilsupport01@gmail.com</a></p>" +
            '<button type="button" class="boot-retry" onclick="location.reload()">Try again</button>' +
            "</div></div>";
        }
      });
  }

  function api(path, body) {
    return fetch(WORKER_URL + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    })
      .then(function (res) {
        return res.json().catch(function () {
          return {};
        }).then(function (data) {
          return { res: res, data: data };
        });
      })
      .catch(function (err) {
        return {
          res: { ok: false, status: 0 },
          data: { ok: false, error: "Could not reach server" },
        };
      });
  }

  function handleAuthResult(data, tokenFromLogin) {
    var token = tokenFromLogin || data.token || getToken();
    var user = data.user;

    if (data.ok && user && user.hasAccess) {
      setToken(token, user);
      unlockApp();
      return;
    }

    if (data.reason === "banned" || (user && (user.status === "banned" || user.banned))) {
      clearToken();
      showBlocked(data.error || "You are banned from Veil");
      return;
    }

    /* Must verify email before pending (or any waiting screen) */
    var needsVerify =
      data.reason === "unverified" ||
      data.needsVerify ||
      (user && user.emailVerified === false) ||
      (user && user.status === "unverified");
    if (needsVerify) {
      if (user && user.email) {
        try { localStorage.setItem(PENDING_EMAIL, user.email); } catch (e) {}
      }
      if (token) setToken(token, user);
      showGate(data.error || "Verify your email", false);
      showPanel("verify");
      return;
    }

    // Verified only: pending / expired / session ended → waiting screen
    if (
      data.reason === "pending" ||
      data.reason === "expired" ||
      data.reason === "signed_out" ||
      (user && (user.status === "pending" || user.status === "expired" || user.hasAccess === false))
    ) {
      if (token) setToken(token, user);
      if (user && user.email) {
        try { localStorage.setItem(PENDING_EMAIL, user.email); } catch (e) {}
      }
      var mode = "pending";
      if (data.reason === "expired" || data.reason === "signed_out") mode = "expired";
      else if (user && user.status === "expired") mode = "expired";
      showPending(user, mode);
      return;
    }

    if (!data.ok) {
      showGate(data.error || "Sign in failed", true);
      showPanel("login");
    }
  }

  
  function checkSession() {
    var token = getToken();
    if (!token) {
      showGate(DEFAULT_MSG, false);
      showPanel("login");
      return Promise.resolve();
    }
    // Quiet check — no boot animation on gate
    setBodyLocked(true);
    if (appRoot) appRoot.style.display = "none";
    return api("/api/session/check", { token: token }).then(function (r) {
      if (r.data && r.data.ok && r.data.user && r.data.user.hasAccess) {
        setToken(token, r.data.user);
        unlockApp();
        return;
      }
      if (r.data) {
        /* Keep token on pending/expired/unverified so refresh stays signed in */
        if (r.data.token) token = r.data.token;
        if (
          r.data.reason === "pending" ||
          r.data.reason === "expired" ||
          r.data.reason === "unverified" ||
          r.data.reason === "signed_out" ||
          (r.data.user && r.data.user.email)
        ) {
          if (token) setToken(token, r.data.user || null);
        }
        handleAuthResult(r.data, token);
        return;
      }
      /* Only clear when server truly has no session */
      clearToken();
      showGate(DEFAULT_MSG, false);
      showPanel("login");
    });
  }

  // Tabs
  document.querySelectorAll("[data-gate-tab]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      showPanel(btn.getAttribute("data-gate-tab"));
      setMsg(DEFAULT_MSG, false);
    });
  });

  var loginBtn = document.getElementById("loginBtn");
  var signupBtn = document.getElementById("signupBtn");
  var verifyBtn = document.getElementById("verifyBtn");
  var resendBtn = document.getElementById("resendVerifyBtn");
  var backBtn = document.getElementById("backToLoginBtn");
  var pendingRefresh = document.getElementById("pendingRefreshBtn");
  var pendingLogout = document.getElementById("pendingLogoutBtn");

  if (loginBtn) {
    loginBtn.onclick = function () {
      var email = (document.getElementById("loginEmail") || {}).value || "";
      var password = (document.getElementById("loginPass") || {}).value || "";
      setMsg("Signing in…", false);
      api("/api/auth/login", { email: email, password: password }).then(function (r) {
        if (r.data.token) setToken(r.data.token, r.data.user);
        handleAuthResult(r.data, r.data.token);
        if (!r.data.ok && !r.data.reason) setMsg(r.data.error || "Login failed", true, true);
      });
    };
  }

  if (signupBtn) {
    signupBtn.onclick = function () {
      var email = (document.getElementById("signupEmail") || {}).value || "";
      var password = (document.getElementById("signupPass") || {}).value || "";
      setMsg("Creating account…", false);
      api("/api/auth/signup", { email: email, password: password }).then(function (r) {
        if (!r.data.ok && !r.data.needsVerify) {
          setMsg(r.data.error || "Signup failed", true, true);
          return;
        }
        try { localStorage.setItem(PENDING_EMAIL, email.trim().toLowerCase()); } catch (e) {}
        showPanel("verify");
        if (r.data.emailSent) setMsg("Code sent — check your inbox (and spam)", false);
        else setMsg(r.data.error || "Account created, but email could not be sent", true, false);
      });
    };
  }

  if (verifyBtn) {
    verifyBtn.onclick = function () {
      var email =
        localStorage.getItem(PENDING_EMAIL) ||
        (document.getElementById("signupEmail") || {}).value ||
        (document.getElementById("loginEmail") || {}).value ||
        "";
      var code = (document.getElementById("verifyCode") || {}).value || "";
      setMsg("Verifying…", false);
      api("/api/auth/verify", { email: email, code: code }).then(function (r) {
        if (!r.data.ok && !r.data.reason) {
          setMsg(r.data.error || "Invalid code", true, true);
          return;
        }
        /* After verify: enter Veil, or pending — never stay unverified */
        if (r.data.token) setToken(r.data.token, r.data.user);
        if (r.data.ok && r.data.user && r.data.user.hasAccess) {
          handleAuthResult(r.data, r.data.token);
          return;
        }
        if (r.data.user || r.data.reason) {
          handleAuthResult(r.data, r.data.token);
          return;
        }
        setMsg("Email verified. Log in to continue.", false);
        showPanel("login");
        var le = document.getElementById("loginEmail");
        if (le && email) le.value = email;
      });
    };
  }

  if (resendBtn) {
    resendBtn.onclick = function () {
      var email =
        localStorage.getItem(PENDING_EMAIL) ||
        (document.getElementById("signupEmail") || {}).value ||
        (document.getElementById("loginEmail") || {}).value ||
        "";
      setMsg("Sending…", false);
      api("/api/auth/resend-verify", { email: email }).then(function (r) {
        if (!r.data.ok) setMsg(r.data.error || "Could not resend", true, true);
        else setMsg("Code sent", false);
      });
    };
  }

  if (backBtn) {
    backBtn.onclick = function () {
      showPanel("login");
      setMsg(DEFAULT_MSG, false);
    };
  }

  if (pendingRefresh) {
    pendingRefresh.onclick = function () {
      quietCheckAccess(false);
    };
  }

  if (pendingLogout) {
    pendingLogout.onclick = function () {
      stopPendingPoll();
      doSignOut();
    };
  }

  // Enter keys
  ["loginPass", "loginEmail"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && loginBtn) loginBtn.click();
    });
  });
  ["signupPass", "signupEmail"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && signupBtn) signupBtn.click();
    });
  });
  var vc = document.getElementById("verifyCode");
  if (vc) vc.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && verifyBtn) verifyBtn.click();
  });

  // ——— Google Sign-In ———
  var googleClientId = null;
  var googleReady = false;

  function onGoogleCredential(response) {
    if (!response || !response.credential) {
      setMsg("Google sign-in failed", true, true);
      return;
    }
    setMsg("Signing in with Google…", false);
    api("/api/auth/google", { credential: response.credential }).then(function (r) {
      var data = r.data || {};
      if (data.token) setToken(data.token, data.user);
      // Always route through handleAuthResult (enter Veil, pending, or ban)
      if (data.ok && data.user && data.user.hasAccess) {
        handleAuthResult(data, data.token);
        return;
      }
      if (data.user || data.reason) {
        handleAuthResult(data, data.token);
        return;
      }
      setMsg(data.error || "Google sign-in failed", true, true);
      showPanel("login");
    });
  }

  function initGoogleButton() {
    if (!googleClientId || googleReady) return;
    if (!window.google || !google.accounts || !google.accounts.id) return;
    try {
      google.accounts.id.initialize({
        client_id: googleClientId,
        callback: onGoogleCredential,
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      var host = document.getElementById("googleSignInBtn");
      var wrap = document.getElementById("googleSignInWrap");
      if (host && wrap) {
        host.innerHTML = "";
        var w = 320;
        try {
          if (gateBox && gateBox.clientWidth) w = Math.min(360, Math.max(240, gateBox.clientWidth - 56));
        } catch (e) {}
        google.accounts.id.renderButton(host, {
          theme: "outline",
          size: "large",
          shape: "rectangular",
          text: "continue_with",
          width: w,
        });
        wrap.style.display = "block";
        googleReady = true;
      }
    } catch (e) {
      console.warn("Google button init", e);
    }
  }

  function loadGoogleScript(clientId) {
    googleClientId = clientId;
    if (window.google && google.accounts) {
      initGoogleButton();
      return;
    }
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = function () {
      initGoogleButton();
    };
    document.head.appendChild(s);
  }

  function fetchAuthConfig() {
    return fetch(WORKER_URL + "/api/auth/config")
      .then(function (res) {
        return res.json().catch(function () {
          return {};
        });
      })
      .then(function (data) {
        if (data && data.googleClientId) loadGoogleScript(data.googleClientId);
      })
      .catch(function () {});
  }

  var _origShowPanel = showPanel;
  showPanel = function (name) {
    _origShowPanel(name);
    var wrap = document.getElementById("googleSignInWrap");
    if (wrap) {
      wrap.style.display =
        googleReady && (name === "login" || name === "signup") ? "block" : "none";
    }
  };

    window.VeilAccess.signOut = doSignOut;

  /* Keep #veilBoot until showGate / unlockApp dismisses it (prevents menu flicker). */
  if (document.body) {
    document.body.classList.remove("booting");
  }

  fetchAuthConfig();
  checkSession();
})();