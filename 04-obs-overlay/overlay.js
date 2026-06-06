/* =====================================================================
 * OmniChat Overlay — single static page for OBS Browser Source.
 *
 * Connects DIRECTLY from the browser to:
 *   - Twitch IRC over WebSocket (anonymous, no key)
 *   - Kick chat over Pusher WebSocket (public app key, no key)
 * For X (Twitter), it POLLS an optional tiny Node proxy (x-proxy.js)
 * that holds the bearer token: GET /x?since=<id>. If the proxy is
 * absent the overlay still runs Twitch + Kick (+ demo) just fine.
 *
 * Config comes from URL query params, e.g.
 *   overlay.html?twitch=ansem,hasanabi&kick=adin&x=1&max=25&ui=1
 *   overlay.html?demo=1
 * ===================================================================== */
(function () {
  "use strict";

  // ---------- config from URL ----------
  var Q = new URLSearchParams(location.search);
  function csv(v) {
    return (v || "")
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }
  var CFG = {
    twitch: csv(Q.get("twitch")),
    kick: csv(Q.get("kick")),
    // ?x=1 enables polling the proxy; ?x=<url> overrides the proxy base.
    x: Q.get("x"),
    max: Math.max(5, parseInt(Q.get("max") || "20", 10) || 20),
    demo: Q.get("demo") === "1",
    ui: Q.get("ui") === "1",
    fade: Q.get("fade") !== "0",          // auto-fade old messages (default on)
    fadeMs: parseInt(Q.get("fadems") || "45000", 10) || 45000,
  };

  // Demo mode if explicitly asked, OR nothing at all is configured.
  var nothingConfigured =
    CFG.twitch.length === 0 && CFG.kick.length === 0 && !CFG.x;
  var DEMO = CFG.demo || nothingConfigured;

  // ---------- source label metadata (per spec) ----------
  var LABELS = {
    twitch: { label: "TWITCH", emoji: "🎮", color: "#9146FF" },
    x:      { label: "X",      emoji: "𝕏",  color: "#1D9BF0" },
    kick:   { label: "KICK",   emoji: "⚡", color: "#53FC18" },
  };

  // ---------- filter state ----------
  var enabled = { twitch: true, x: true, kick: true };

  // ---------- DOM ----------
  var stage = document.getElementById("stage");
  var bar = document.getElementById("bar");
  var statusEl = document.getElementById("status");
  if (CFG.ui) bar.classList.add("show");

  var liveStatus = { twitch: "off", kick: "off", x: "off" };
  function setStatus(src, s) {
    liveStatus[src] = s;
    if (!statusEl) return;
    statusEl.textContent =
      "tw:" + liveStatus.twitch + " | kick:" + liveStatus.kick + " | x:" + liveStatus.x +
      (DEMO ? " | DEMO" : "");
  }

  Array.prototype.forEach.call(bar.querySelectorAll("button"), function (btn) {
    var src = btn.getAttribute("data-src");
    btn.addEventListener("click", function () {
      enabled[src] = !enabled[src];
      btn.classList.toggle("on", enabled[src]);
      // hide/show already-rendered rows of that source
      Array.prototype.forEach.call(
        stage.querySelectorAll('.msg[data-src="' + src + '"]'),
        function (el) { el.style.display = enabled[src] ? "" : "none"; }
      );
    });
  });

  // ---------- render ----------
  var seen = Object.create(null); // de-dupe by id
  var count = 0;

  function escapeText(t) {
    return String(t == null ? "" : t).replace(/[\r\n]+/g, " ").trim();
  }

  function emit(m) {
    if (!m || !m.id || seen[m.id]) return;
    seen[m.id] = 1;
    if (!enabled[m.source]) return; // filtered out — don't render

    var meta = LABELS[m.source] || { label: m.source, emoji: "", color: "#888" };

    var row = document.createElement("div");
    row.className = "msg";
    row.setAttribute("data-src", m.source);

    var badge = document.createElement("span");
    badge.className = "badge badge-" + m.source;
    badge.innerHTML =
      '<span class="em">' + meta.emoji + "</span>" + meta.label;
    row.appendChild(badge);

    if (m.channel) {
      var chan = document.createElement("span");
      chan.className = "chan";
      chan.textContent = "#" + m.channel;
      row.appendChild(chan);
    }

    var author = document.createElement("span");
    author.className = "author";
    author.textContent = m.author || "anon";
    author.style.color = m.color || meta.color || "#fff";
    row.appendChild(author);

    var text = document.createElement("span");
    text.className = "text";
    text.textContent = escapeText(m.text);
    row.appendChild(text);

    stage.appendChild(row);
    count++;

    // Cap retained messages in the DOM.
    while (stage.children.length > CFG.max) {
      var first = stage.firstElementChild;
      if (first) stage.removeChild(first);
    }

    // Auto-fade old message after a while (purely visual).
    if (CFG.fade) {
      setTimeout(function () {
        row.classList.add("fade");
        setTimeout(function () {
          if (row.parentNode) row.parentNode.removeChild(row);
        }, 1300);
      }, CFG.fadeMs);
    }
  }

  // Bounded de-dupe map so `seen` can't grow forever.
  setInterval(function () {
    if (Object.keys(seen).length > 4000) seen = Object.create(null);
  }, 60000);

  // =====================================================================
  // TWITCH — anonymous IRC over WebSocket
  // =====================================================================
  function connectTwitch(channels) {
    if (!channels.length) return;
    var backoff = 1000;
    var ws;

    function open() {
      setStatus("twitch", "connecting");
      ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

      ws.onopen = function () {
        backoff = 1000;
        setStatus("twitch", "live");
        ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
        ws.send("NICK justinfan" + Math.floor(Math.random() * 90000 + 1000) + "\r\n");
        channels.forEach(function (c) {
          ws.send("JOIN #" + c.toLowerCase() + "\r\n");
        });
      };

      ws.onmessage = function (ev) {
        var lines = ev.data.split("\r\n");
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line) continue;
          if (line.indexOf("PING") === 0) {
            ws.send("PONG :tmi.twitch.tv\r\n");
            continue;
          }
          if (line.indexOf(" PRIVMSG ") === -1) continue;
          parseTwitch(line);
        }
      };

      ws.onclose = function () { retry(); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }

    function retry() {
      setStatus("twitch", "reconnecting");
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30000);
    }

    open();
  }

  function parseTwitch(line) {
    var tags = {};
    if (line[0] === "@") {
      var sp = line.indexOf(" ");
      var tagstr = line.slice(1, sp);
      line = line.slice(sp + 1);
      tagstr.split(";").forEach(function (kv) {
        var eq = kv.indexOf("=");
        if (eq > -1) tags[kv.slice(0, eq)] = kv.slice(eq + 1);
      });
    }
    // line now: ":alice!alice@... PRIVMSG #chan :hello world"
    var pm = line.indexOf(" PRIVMSG ");
    if (pm === -1) return;
    var after = line.slice(pm + " PRIVMSG ".length); // "#chan :hello world"
    var sep = after.indexOf(" :");
    if (sep === -1) return;
    var channel = after.slice(0, sep).replace(/^#/, "");
    var text = after.slice(sep + 2);
    var author =
      tags["display-name"] ||
      (line.indexOf("!") > -1 ? line.slice(1, line.indexOf("!")) : "anon");

    emit({
      id: tags["id"] || "tw-" + channel + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      source: "twitch",
      channel: channel,
      author: author,
      text: text,
      color: tags["color"] || "",
      ts: Date.now(),
    });
  }

  // =====================================================================
  // KICK — Pusher WebSocket. Needs chatroom ids; the browser can't reliably
  // hit Kick's CF-protected API, so we resolve ids via the optional proxy
  // (GET /kickid?slug=...). If proxy/ids unavailable, Kick is skipped.
  // =====================================================================
  function connectKick(slugs) {
    if (!slugs.length) return;
    var proxyBase = xProxyBase(); // reuse the same Node proxy if present
    var idMap = {}; // chatroomId -> slug

    function resolveAll(done) {
      var pending = slugs.length;
      var any = false;
      slugs.forEach(function (slug) {
        // allow ?kickid_<slug>=123 override directly in URL
        var override = Q.get("kickid_" + slug) || Q.get("kickid");
        if (override) {
          idMap[override] = slug; any = true;
          if (--pending === 0) done(any);
          return;
        }
        if (!proxyBase) { if (--pending === 0) done(any); return; }
        fetch(proxyBase + "/kickid?slug=" + encodeURIComponent(slug))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (j && j.id) { idMap[String(j.id)] = slug; any = true; }
          })
          .catch(function () {})
          .then(function () { if (--pending === 0) done(any); });
      });
    }

    setStatus("kick", "resolving");
    resolveAll(function (ok) {
      if (!ok) { setStatus("kick", "no-ids"); return; }
      openPusher();
    });

    var ws, backoff = 1000;
    function openPusher() {
      setStatus("kick", "connecting");
      ws = new WebSocket(
        "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false"
      );
      ws.onmessage = function (ev) {
        var frame;
        try { frame = JSON.parse(ev.data); } catch (e) { return; }
        if (frame.event === "pusher:connection_established") {
          backoff = 1000;
          setStatus("kick", "live");
          Object.keys(idMap).forEach(function (id) {
            ws.send(JSON.stringify({
              event: "pusher:subscribe",
              data: { auth: "", channel: "chatrooms." + id + ".v2" },
            }));
          });
          return;
        }
        if (frame.event === "pusher:ping") {
          ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
          return;
        }
        if (frame.event === "App\\Events\\ChatMessage") {
          var d;
          try { d = JSON.parse(frame.data); } catch (e) { return; }
          var chId = (frame.channel || "").replace(/^chatrooms\./, "").replace(/\.v2$/, "");
          emit({
            id: d.id || "kick-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
            source: "kick",
            channel: idMap[chId] || chId,
            author: (d.sender && d.sender.username) || "anon",
            text: d.content || "",
            color: (d.sender && d.sender.identity && d.sender.identity.color) || "",
            ts: Date.now(),
          });
        }
      };
      ws.onclose = function () {
        setStatus("kick", "reconnecting");
        setTimeout(openPusher, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }
  }

  // =====================================================================
  // X — poll the optional Node proxy. The proxy holds the bearer token
  // and returns { messages: [...unified...] } for new tweets since an id.
  // =====================================================================
  function xProxyBase() {
    if (!CFG.x) return null;
    // ?x=1 -> same origin; ?x=http://host:port -> explicit base
    if (CFG.x === "1" || CFG.x === "true") return location.origin;
    return CFG.x.replace(/\/$/, "");
  }

  function connectX() {
    var base = xProxyBase();
    if (!base) return;
    var since = "";
    var backoff = 12000;

    function poll() {
      setStatus("x", "polling");
      fetch(base + "/x?since=" + encodeURIComponent(since))
        .then(function (r) {
          if (r.status === 429) { backoff = Math.min(backoff * 2, 90000); throw new Error("ratelimit"); }
          if (!r.ok) throw new Error("http " + r.status);
          return r.json();
        })
        .then(function (j) {
          backoff = 12000;
          setStatus("x", "live");
          var msgs = (j && j.messages) || [];
          msgs.forEach(function (m) {
            m.source = "x";
            emit(m);
            if (m.id && m.id > since) since = m.id;
          });
          if (j && j.since) since = j.since;
          setTimeout(poll, 12000);
        })
        .catch(function () {
          setStatus("x", "retry");
          setTimeout(poll, backoff);
        });
    }
    poll();
  }

  // =====================================================================
  // DEMO MODE — synthetic crypto-stream-flavored messages from all 3
  // =====================================================================
  function startDemo() {
    setStatus("twitch", "demo");
    setStatus("kick", "demo");
    setStatus("x", "demo");
    var authors = {
      twitch: ["sol_sniper", "degenDan", "chartWizard", "gm_anon", "liqHunter"],
      kick:   ["kickWhale", "memelord", "apeStrong", "nightTrader", "pnl_andy"],
      x:      ["cryptochad", "onchain_oracle", "alphaLeak", "wenLambo", "bagHolder"],
    };
    var texts = [
      "ANSEM CALLED THE TOP AGAIN 😤",
      "longs getting liquidated rn 💀",
      "this candle is insane",
      "buying the dip, see you at ATH",
      "gm degens ☕ what we trading",
      "size up or stay poor",
      "RSI says oversold, sending it",
      "who else is up bad today 📉",
      "new ATH incoming, screenshot this",
      "funding flipped negative, bullish",
      "100x leverage no stop loss lfg",
      "wen breakout king 👑",
      "fading this pump tbh",
      "bags packed, ready for the move",
    ];
    var chans = {
      twitch: ["ansem", "blknoiz06"],
      kick:   ["trading", "degencave"],
      x:      ["$SOL", "@blknoiz06"],
    };
    var srcs = ["twitch", "kick", "x"];
    var i = 0;
    setInterval(function () {
      var src = srcs[i % 3]; i++;
      var a = authors[src][Math.floor(Math.random() * authors[src].length)];
      var t = texts[Math.floor(Math.random() * texts.length)];
      var c = chans[src][Math.floor(Math.random() * chans[src].length)];
      emit({
        id: "demo-" + src + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        source: src,
        channel: c,
        author: a,
        text: t,
        color: "",
        ts: Date.now(),
      });
    }, 800);
  }

  // =====================================================================
  // boot
  // =====================================================================
  if (DEMO) {
    startDemo();
  } else {
    connectTwitch(CFG.twitch);
    connectKick(CFG.kick);
    connectX();
  }
  setStatus("twitch", liveStatus.twitch); // paint initial status line
})();
