"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";

const META = {
  twitch: { label: "TWITCH", emoji: "🎮", color: "#9146FF" },
  x: { label: "X", emoji: "𝕏", color: "#1D9BF0" },
  kick: { label: "KICK", emoji: "⚡", color: "#53FC18" },
};
const CAP = 500; // cap retained messages in the UI

export default function RoomPage({ params }) {
  const roomId = params.id;
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [filters, setFilters] = useState({ twitch: true, x: true, kick: true });
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState({ twitch: 0, x: 0, kick: 0 });

  const feedRef = useRef(null);
  const seen = useRef(new Set());
  const tsBuckets = useRef([]); // {source, ts} within last 60s

  // ---- load room meta
  useEffect(() => {
    fetch("/api/rooms/" + roomId)
      .then((r) => r.json())
      .then((j) => setRoom(j.room || null));
  }, [roomId]);

  // ---- add a message (dedupe + cap)
  const addMessage = useCallback((m) => {
    if (seen.current.has(m.id)) return;
    seen.current.add(m.id);
    tsBuckets.current.push({ source: m.source, ts: Date.now() });
    setMessages((prev) => {
      const next = prev.concat(m);
      if (next.length > CAP) {
        const removed = next.splice(0, next.length - CAP);
        for (const r of removed) seen.current.delete(r.id);
      }
      return next;
    });
  }, []);

  // ---- SSE live stream with reconnect/backoff
  useEffect(() => {
    let es = null;
    let stopped = false;
    let backoff = 1000;

    function connect() {
      if (stopped) return;
      es = new EventSource("/api/rooms/" + roomId + "/stream");
      es.onopen = () => {
        setConnected(true);
        backoff = 1000;
      };
      es.onmessage = (ev) => {
        let payload;
        try {
          payload = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        if (payload.type === "msg" && payload.message) addMessage(payload.message);
      };
      es.onerror = () => {
        setConnected(false);
        try { es.close(); } catch (e) {}
        if (stopped) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15000);
      };
    }
    connect();
    return () => {
      stopped = true;
      if (es) try { es.close(); } catch (e) {}
    };
  }, [roomId, addMessage]);

  // ---- analytics: msgs/min per source over a rolling 60s window
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - 60000;
      tsBuckets.current = tsBuckets.current.filter((b) => b.ts >= cutoff);
      const r = { twitch: 0, x: 0, kick: 0 };
      for (const b of tsBuckets.current) r[b.source] = (r[b.source] || 0) + 1;
      setRate(r);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ---- auto-scroll unless paused or user scrolled up
  useEffect(() => {
    if (paused) return;
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, paused]);

  function onScroll() {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setPaused(!atBottom);
  }

  async function loadHistory() {
    const res = await fetch("/api/rooms/" + roomId + "/history?limit=500");
    const json = await res.json();
    const hist = json.messages || [];
    setMessages((prev) => {
      // merge history before current live messages, dedupe
      const map = new Map();
      for (const m of hist) map.set(m.id, m);
      for (const m of prev) map.set(m.id, m);
      const merged = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
      for (const m of merged) seen.current.add(m.id);
      return merged.slice(-CAP);
    });
  }

  function toggle(src) {
    setFilters((f) => ({ ...f, [src]: !f[src] }));
  }

  const visible = messages.filter((m) => filters[m.source]);

  return (
    <div className="wrap">
      <div className="topbar">
        <div>
          <Link href="/" className="muted">
            ← rooms
          </Link>
          <div className="brand" style={{ marginTop: 4 }}>
            {room ? room.name : "Room"}
          </div>
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          {connected ? "🟢 live" : "🔴 reconnecting…"}
        </div>
      </div>

      {/* analytics strip */}
      <div className="card" style={{ padding: "12px 16px" }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="stats">
            <div className="stat" style={{ color: META.twitch.color }}>
              🎮 <b>{rate.twitch}</b> <span className="muted">/min</span>
            </div>
            <div className="stat" style={{ color: META.x.color }}>
              𝕏 <b>{rate.x}</b> <span className="muted">/min</span>
            </div>
            <div className="stat" style={{ color: META.kick.color }}>
              ⚡ <b>{rate.kick}</b> <span className="muted">/min</span>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {visible.length} shown / {messages.length} held
          </div>
        </div>
      </div>

      {/* controls */}
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <div className="toggles">
          {["twitch", "x", "kick"].map((src) => (
            <div
              key={src}
              className={"toggle" + (filters[src] ? "" : " off")}
              style={{ color: META[src].color }}
              onClick={() => toggle(src)}
            >
              {META[src].emoji} {META[src].label}
            </div>
          ))}
        </div>
        <button className="btn" onClick={loadHistory}>
          Load history
        </button>
      </div>

      {paused && (
        <div className="paused" style={{ marginBottom: 8 }}>
          Auto-scroll paused (scrolled up). Scroll to bottom to resume.
        </div>
      )}

      {/* feed */}
      <div className="feed" ref={feedRef} onScroll={onScroll}>
        {visible.length === 0 && (
          <div className="muted dim" style={{ padding: 20, textAlign: "center" }}>
            Waiting for messages…
          </div>
        )}
        {visible.map((m, i) => {
          const meta = META[m.source] || { label: m.source, emoji: "", color: "#888" };
          return (
            <div className="msg" key={m.id + ":" + i}>
              <span className="badge" style={{ background: meta.color }}>
                {meta.emoji} {meta.label}
              </span>
              <span className="chan">{m.channel}</span>
              <span
                className="author"
                style={{ color: m.color || meta.color }}
              >
                {m.author}
              </span>
              <span className="text">{m.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
