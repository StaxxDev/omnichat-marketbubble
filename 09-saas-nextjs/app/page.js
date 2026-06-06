"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function Home() {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    name: "",
    twitch: "",
    kick: "",
    kickIds: "",
    xMode: "hashtag",
    xTarget: "",
    demo: false,
  });
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/rooms");
    const json = await res.json();
    setRooms(json.rooms || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e) {
    e.preventDefault();
    setCreating(true);
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const json = await res.json();
    setCreating(false);
    if (json.room) {
      setForm({
        name: "",
        twitch: "",
        kick: "",
        kickIds: "",
        xMode: "hashtag",
        xTarget: "",
        demo: false,
      });
      load();
    }
  }

  function up(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">
          OmniChat <span>Cloud</span>
        </div>
        <div className="muted">Twitch + X + Kick, one labeled feed</div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Create a room</h3>
        <form onSubmit={create}>
          <label>Room name</label>
          <input
            value={form.name}
            onChange={(e) => up("name", e.target.value)}
            placeholder="Ansem co-stream"
          />
          <div className="grid2">
            <div>
              <label>Twitch channels (csv logins)</label>
              <input
                value={form.twitch}
                onChange={(e) => up("twitch", e.target.value)}
                placeholder="xqc, ansem"
              />
            </div>
            <div>
              <label>Kick channels (csv slugs)</label>
              <input
                value={form.kick}
                onChange={(e) => up("kick", e.target.value)}
                placeholder="adin, trainwreckstv"
              />
            </div>
          </div>
          <div className="grid2">
            <div>
              <label>Kick chatroom ids (optional csv, aligned to slugs)</label>
              <input
                value={form.kickIds}
                onChange={(e) => up("kickIds", e.target.value)}
                placeholder="leave blank to auto-resolve"
              />
            </div>
            <div>
              <label>X target (handle / tag / conversation id)</label>
              <input
                value={form.xTarget}
                onChange={(e) => up("xTarget", e.target.value)}
                placeholder="bitcoin"
              />
            </div>
          </div>
          <div className="grid2">
            <div>
              <label>X mode</label>
              <select value={form.xMode} onChange={(e) => up("xMode", e.target.value)}>
                <option value="hashtag">hashtag</option>
                <option value="mentions">mentions</option>
                <option value="replies">replies</option>
              </select>
            </div>
            <div>
              <label>Demo mode</label>
              <div className="row" style={{ paddingTop: 6 }}>
                <label style={{ margin: 0, color: "var(--text)" }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto", marginRight: 8 }}
                    checked={form.demo}
                    onChange={(e) => up("demo", e.target.checked)}
                  />
                  Inject synthetic messages
                </label>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={creating}>
              {creating ? "Creating..." : "Create room"}
            </button>
            <span className="muted" style={{ marginLeft: 12, fontSize: 13 }}>
              No real targets? It auto-runs in demo mode.
            </span>
          </div>
        </form>
      </div>

      <h3>Rooms</h3>
      {loading && <div className="muted">Loading...</div>}
      {!loading && rooms.length === 0 && <div className="muted">No rooms yet.</div>}
      {rooms.map((r) => (
        <Link key={r.id} href={"/room/" + r.id}>
          <div className="card" style={{ cursor: "pointer" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{r.name}</strong>
                {r.demo && (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                    demo
                  </span>
                )}
                <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                  {r.twitch ? "🎮 " + r.twitch + "  " : ""}
                  {r.kick ? "⚡ " + r.kick + "  " : ""}
                  {r.xTarget ? "𝕏 " + r.xMode + ":" + r.xTarget : ""}
                  {!r.twitch && !r.kick && !r.xTarget ? "synthetic feed" : ""}
                </div>
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {r.messageCount} msgs →
              </div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
