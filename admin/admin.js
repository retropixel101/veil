(function () {
  try {
    var q = new URLSearchParams(location.search);
    if (q.get("worker")) {
      localStorage.setItem("veil_worker_url", q.get("worker").replace(/\/$/, ""));
    }
  } catch (e) {}
})();

var WORKER_URL = (
  localStorage.getItem("veil_worker_url") ||
  "https://veil-access.retropixel404.workers.dev"
).replace(/\/$/, "");

var adminToken = "";

function $(id) {
  return document.getElementById(id);
}

function flash(el, text, ok) {
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg " + (ok === true ? "ok" : ok === false ? "err" : "");
  if (text) {
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.textContent = "";
      el.className = "msg";
    }, 3000);
  }
}

function api(path, opts) {
  opts = opts || {};
  var headers = { "content-type": "application/json" };
  if (adminToken) headers["x-veil-admin"] = adminToken;
  return fetch(WORKER_URL + path, {
    method: opts.method || "GET",
    headers: headers,
    body: opts.body,
  })
    .then(function (res) {
      return res.json().catch(function () {
        return {};
      }).then(function (data) {
        return { res: res, data: data };
      });
    })
    .catch(function () {
      return { res: { ok: false, status: 0 }, data: { ok: false, error: "Could not reach server" } };
    });
}

function showApp(ok) {
  $("loginView").classList.toggle("show", !ok);
  $("appView").classList.toggle("show", ok);
  $("brand").classList.toggle("show", ok);
}

$("loginBtn").onclick = function () {
  flash($("loginMsg"), "Checking…");
  api("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ password: $("adminPass").value }),
  }).then(function (r) {
    if (!r.data.ok) {
      flash($("loginMsg"), r.data.error || "Wrong password", false);
      return;
    }
    adminToken = r.data.token || "";
    $("adminPass").value = "";
    flash($("loginMsg"), "");
    showApp(true);
    loadUsers();
  });
};

$("adminPass").addEventListener("keydown", function (e) {
  if (e.key === "Enter") $("loginBtn").click();
});

$("signoutAll").onclick = function () {
  if (!confirm("Sign out every user who is online right now?")) return;
  api("/api/admin/signout-all", { method: "POST", body: "{}" }).then(function (r) {
    flash($("globalMsg"), r.data.ok ? "Everyone was signed out" : r.data.error || "Failed", !!r.data.ok);
  });
};

$("refreshUsers").onclick = function () {
  loadUsers();
};

var searchTimer = null;
$("userSearch").addEventListener("input", function () {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadUsers, 250);
});

function badge(status) {
  var s = status || "pending";
  var label = s;
  if (s === "allowed") label = "allowed";
  else if (s === "pending") label = "pending";
  else if (s === "expired") label = "expired";
  else if (s === "banned") label = "banned";
  else if (s === "unverified") label = "unverified";
  return '<span class="badge ' + s + '">' + label + "</span>";
}

function accessLine(u) {
  if (u.banned || u.status === "banned") {
    var bl = u.banRemainingHuman || "unlimited";
    return "Banned · " + bl + (u.banReason ? " · " + u.banReason : "");
  }
  if (u.status === "unverified" || u.emailVerified === false) {
    return "Unverified · no access until email is confirmed";
  }
  if (u.infinite || u.remainingLabel === "inf") {
    return "Access: unlimited";
  }
  if (u.status === "allowed" && (u.remainingHuman || u.remainingLabel)) {
    return "Access left: " + (u.remainingHuman || u.remainingLabel);
  }
  if (u.status === "expired") {
    return "Access: expired";
  }
  if (u.status === "pending") {
    return "Access: none (waiting for time)";
  }
  return "Access: " + (u.remainingHuman || u.remainingLabel || "none");
}

function fmtDate(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch (e) {
    return "—";
  }
}

function postUser(path, email, extra, msg, okText) {
  var body = Object.assign({ email: email }, extra || {});
  api(path, { method: "POST", body: JSON.stringify(body) }).then(function (res) {
    flash(msg, res.data.ok ? okText || "Done" : res.data.error || "Failed", !!res.data.ok);
    if (res.data.ok) loadUsers();
  });
}

function loadUsers() {
  var q = ($("userSearch").value || "").trim();
  var path = "/api/admin/users" + (q ? "?q=" + encodeURIComponent(q) : "");
  api(path).then(function (r) {
    var list = $("userList");
    list.innerHTML = "";
    if (!r.data.ok) {
      list.innerHTML = '<div class="msg err">' + (r.data.error || "Failed") + "</div>";
      return;
    }
    var users = r.data.users || [];
    if (!users.length) {
      list.innerHTML = '<div class="msg">No users</div>';
      return;
    }
    users.forEach(function (u) {
      var status = u.status || "pending";
      // Prefer server status; don't double-badge unverified
      var extraBadges = "";
      if (u.googleLinked) extraBadges += '<span class="badge google">google</span>';
      var div = document.createElement("div");
      div.className = "user";
      div.innerHTML =
        '<div class="user-email">' +
        escapeHtml(u.email) +
        badge(status) +
        extraBadges +
        "</div>" +
        '<div class="user-meta">' +
        escapeHtml(accessLine(u)) +
        " · last login " +
        escapeHtml(fmtDate(u.lastLogin)) +
        "</div>" +
        '<div class="detail">' +
        '<div class="user-meta" style="margin-bottom:10px">' +
        (u.expires && !u.infinite
          ? "Expires: " + escapeHtml(fmtDate(u.expires)) + "<br>"
          : u.infinite
            ? "Expires: never<br>"
            : "") +
        (u.banReason ? "Ban reason: " + escapeHtml(u.banReason) + "<br>" : "") +
        "Joined " +
        escapeHtml(fmtDate(u.created)) +
        (u.hasPassword ? " · password set" : " · no password") +
        "</div>" +
        '<label class="hint">Give access time</label>' +
        '<div class="row">' +
        '<input type="text" class="dur" placeholder="e.g. 1d, 2h, 30m, inf" value="1d" />' +
        '<select class="mode"><option value="set">Replace</option><option value="add">Add on</option></select>' +
        '<button type="button" class="primary grant">Give time</button>' +
        "</div>" +
        '<label class="hint">Ban user</label>' +
        '<div class="row">' +
        '<input type="text" class="bandur" placeholder="How long (1d or inf)" value="1d" />' +
        '<input type="text" class="banreason" placeholder="Why (optional)" />' +
        '<button type="button" class="danger ban">Ban</button>' +
        "</div>" +
        '<label class="hint">Reset password</label>' +
        '<div class="row">' +
        '<input type="text" class="newpass" placeholder="New password" />' +
        '<button type="button" class="setpass">Save</button>' +
        "</div>" +
        '<div class="row actions" style="margin-top:12px">' +
        '<button type="button" class="kick">End access</button>' +
        (u.status === "banned" ? '<button type="button" class="unban">Remove ban</button>' : "") +
        (!u.emailVerified ? '<button type="button" class="verify">Mark verified</button>' : "") +
        '<button type="button" class="danger delacc">Delete account</button>' +
        "</div>" +
        '<div class="msg actmsg"></div>' +
        "</div>";

      div.addEventListener("click", function (e) {
        if (e.target.closest("button, input, select")) return;
        div.classList.toggle("open");
      });

      var msg = div.querySelector(".actmsg");

      div.querySelector(".grant").onclick = function (e) {
        e.stopPropagation();
        postUser(
          "/api/admin/users/grant",
          u.email,
          { duration: div.querySelector(".dur").value, mode: div.querySelector(".mode").value },
          msg,
          "Time updated"
        );
      };

      div.querySelector(".ban").onclick = function (e) {
        e.stopPropagation();
        var duration = div.querySelector(".bandur").value || "inf";
        var reason = div.querySelector(".banreason").value || "";
        if (!confirm("Ban " + u.email + " for " + duration + "?")) return;
        postUser("/api/admin/users/ban", u.email, { duration: duration, reason: reason }, msg, "User banned");
      };

      div.querySelector(".setpass").onclick = function (e) {
        e.stopPropagation();
        postUser(
          "/api/admin/users/set-password",
          u.email,
          { password: div.querySelector(".newpass").value },
          msg,
          "Password saved"
        );
      };

      div.querySelector(".kick").onclick = function (e) {
        e.stopPropagation();
        if (!confirm("End access for " + u.email + "? They will be signed out and need new time.")) return;
        postUser("/api/admin/users/invalidate", u.email, {}, msg, "Access ended");
      };

      var unban = div.querySelector(".unban");
      if (unban) {
        unban.onclick = function (e) {
          e.stopPropagation();
          postUser("/api/admin/users/unban", u.email, {}, msg, "Ban removed");
        };
      }
            var verify = div.querySelector(".verify");
      if (verify) {
        verify.onclick = function (e) {
          e.stopPropagation();
          postUser("/api/admin/users/verify", u.email, {}, msg, "Marked verified");
        };
      }

      var delacc = div.querySelector(".delacc");
      if (delacc) {
        delacc.onclick = function (e) {
          e.stopPropagation();
          if (!confirm("Delete account " + u.email + "?\n\nThis removes the account completely. They must sign up and verify again.")) return;
          if (!confirm("Really delete " + u.email + "? This cannot be undone.")) return;
          postUser("/api/admin/users/delete", u.email, {}, msg, "Account deleted");
        };
      }


      list.appendChild(div);
    });
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
