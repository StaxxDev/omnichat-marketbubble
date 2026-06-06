/* =====================================================================
 * x-proxy.js — tiny zero-dependency Node helper for OmniChat Overlay.
 *
 * It does three small things (no framework, only Node's http/https):
 *   1) Serves the static overlay files (overlay.html / overlay.js).
 *   2) GET /x?since=<id>  -> polls X API v2 with the bearer token it holds
 *                            and returns new tweets as unified messages.
 *   3) GET /kickid?slug=  -> resolves a Kick slug to its chatroom id
 *                            (server-side, with a browser-like UA so it
 *                             gets past Cloudflare). Lets the browser
 *                             overlay connect Kick without CORS pain.
 *
 * Everything is OPTIONAL: the overlay.html runs Twitch + Kick (+ demo)
 * with no proxy at all. Run this only if you want the X feed and/or a
 * single same-origin URL to drop into OBS.
 *
 * Env: X_BEARER_TOKEN, X_MODE (replies|mentions|hashtag), X_TARGET, PORT,
 *      KICK_CHATROOM_IDS (optional csv aligned to slugs you pass).
 * ===================================================================== */
"use strict";

var http = require("http");
var https = require("https");
var fs = require("fs");
var path = require("path");
var url = require("url");

// load .env if present (no dependency)
(function loadEnv() {
  try {
    var p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    fs.readFileSync(p, "utf8").split(/\r?\n/).forEach(function (line) {
      var m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) return;
      var v = m[2].replace(/^["']|["']$/g, "");
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    });
  } catch (e) {}
})();

var PORT = parseInt(process.env.PORT || "8787", 10);
var TOKEN = process.env.X_BEARER_TOKEN || "";
var X_MODE = process.env.X_MODE || "hashtag";
var X_TARGET = process.env.X_TARGET || "";

// Build the X recent-search query from mode + target.
function buildQuery() {
  if (!X_TARGET) return "";
  if (X_MODE === "replies") return "conversation_id:" + X_TARGET;
  if (X_MODE === "mentions") return "@" + X_TARGET + " -is:retweet";
  return "#" + X_TARGET.replace(/^#/, "") + " -is:retweet"; // hashtag (default)
}

// ---- X recent search -> unified messages ----
function fetchX(since, cb) {
  if (!TOKEN || !X_TARGET) return cb(null, { messages: [], note: "x-disabled" });

  var q = buildQuery();
  var params =
    "query=" + encodeURIComponent(q) +
    "&max_results=100" +
    "&tweet.fields=created_at,author_id" +
    "&expansions=author_id" +
    "&user.fields=username";
  if (since) params += "&since_id=" + encodeURIComponent(since);

  var opts = {
    hostname: "api.twitter.com",
    path: "/2/tweets/search/recent?" + params,
    method: "GET",
    headers: { Authorization: "Bearer " + TOKEN, "User-Agent": "omnichat-overlay" },
  };

  var req = https.request(opts, function (res) {
    var body = "";
    res.on("data", function (d) { body += d; });
    res.on("end", function () {
      if (res.statusCode === 429) return cb(429, null);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return cb(null, { messages: [], note: "x-http-" + res.statusCode });
      }
      var j;
      try { j = JSON.parse(body); } catch (e) { return cb(null, { messages: [] }); }
      var users = {};
      ((j.includes && j.includes.users) || []).forEach(function (u) {
        users[u.id] = u.username;
      });
      var data = (j.data || []).slice().reverse(); // newest-first -> chronological
      var maxId = since || "";
      var messages = data.map(function (t) {
        if (!maxId || t.id > maxId) maxId = t.id;
        return {
          id: t.id,
          source: "x",
          channel: X_TARGET,
          author: users[t.author_id] || t.author_id || "x-user",
          text: (t.text || "").replace(/[\r\n]+/g, " ").trim(),
          color: "",
          ts: t.created_at ? Date.parse(t.created_at) : Date.now(),
        };
      });
      cb(null, { messages: messages, since: maxId });
    });
  });
  req.on("error", function () { cb(null, { messages: [], note: "x-error" }); });
  req.end();
}

// ---- Kick slug -> chatroom id (server-side, browser-like UA) ----
function resolveKickId(slug, cb) {
  // optional manual override aligned by slug=value pairs in KICK_CHATROOM_IDS
  // form "slug:id,slug2:id2" OR a single id.
  var envIds = process.env.KICK_CHATROOM_IDS || "";
  if (envIds) {
    var pair = envIds.split(",").map(function (s) { return s.trim(); })
      .find(function (s) { return s.indexOf(slug + ":") === 0; });
    if (pair) return cb(null, parseInt(pair.split(":")[1], 10));
  }

  var opts = {
    hostname: "kick.com",
    path: "/api/v2/channels/" + encodeURIComponent(slug),
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json",
    },
  };
  var req = https.request(opts, function (res) {
    var body = "";
    res.on("data", function (d) { body += d; });
    res.on("end", function () {
      if (res.statusCode !== 200) return cb("http-" + res.statusCode, null);
      try {
        var j = JSON.parse(body);
        cb(null, j && j.chatroom && j.chatroom.id);
      } catch (e) { cb("parse", null); }
    });
  });
  req.on("error", function (e) { cb("err", null); });
  req.end();
}

// ---- static file serving ----
var MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css" };
function serveStatic(res, file) {
  var full = path.join(__dirname, file);
  if (!full.startsWith(__dirname)) { res.writeHead(403); return res.end("no"); }
  fs.readFile(full, function (err, buf) {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(buf);
  });
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
}

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);

  if (u.pathname === "/x") {
    cors(res);
    fetchX(u.query.since || "", function (code, out) {
      if (code === 429) { res.writeHead(429, { "Content-Type": "application/json" }); return res.end('{"error":"ratelimit"}'); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (u.pathname === "/kickid") {
    cors(res);
    resolveKickId(u.query.slug || "", function (err, id) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(id ? { id: id } : { error: err || "no-id" }));
    });
    return;
  }

  if (u.pathname === "/" || u.pathname === "/overlay" || u.pathname === "/overlay.html") {
    return serveStatic(res, "overlay.html");
  }
  if (u.pathname === "/overlay.js") return serveStatic(res, "overlay.js");

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, function () {
  console.log("OmniChat Overlay proxy on http://localhost:" + PORT);
  console.log("  overlay:  http://localhost:" + PORT + "/overlay.html?x=1");
  console.log("  X feed:   " + (TOKEN && X_TARGET ? (X_MODE + " -> " + X_TARGET) : "(disabled: set X_BEARER_TOKEN + X_TARGET)"));
});
