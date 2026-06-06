import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFeed } from './useFeed.js';

// Fallback source metadata if the server hello hasn't arrived yet.
const FALLBACK_SOURCES = {
  twitch: { label: 'TWITCH', emoji: '🎮', color: '#9146FF' },
  x: { label: 'X', emoji: '𝕏', color: '#1D9BF0' },
  kick: { label: 'KICK', emoji: '⚡', color: '#53FC18' },
};

function Badge({ meta }) {
  return (
    <span className="badge" style={{ background: meta.color }}>
      <span className="badge-emoji">{meta.emoji}</span>
      {meta.label}
    </span>
  );
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
}

export default function App() {
  const { messages, status, sources, config } = useFeed();
  const srcMeta = sources || FALLBACK_SOURCES;

  // three source-filter toggles
  const [show, setShow] = useState({ twitch: true, x: true, kick: true });
  const toggle = (s) => setShow((p) => ({ ...p, [s]: !p[s] }));

  const visible = useMemo(
    () => messages.filter((m) => show[m.source]),
    [messages, show]
  );

  // auto-scroll, pausable on hover / scroll-up
  const feedRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const hoveringRef = useRef(false);

  useEffect(() => {
    const el = feedRef.current;
    if (!el || !autoScroll || hoveringRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visible, autoScroll]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(nearBottom);
  };

  const counts = useMemo(() => {
    const c = { twitch: 0, x: 0, kick: 0 };
    for (const m of messages) if (c[m.source] !== undefined) c[m.source] += 1;
    return c;
  }, [messages]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">📡</span>
          <h1>OmniChat Hub</h1>
          <span className="tagline">Twitch · X · Kick — one live feed</span>
        </div>

        <div className="controls">
          {['twitch', 'x', 'kick'].map((s) => {
            const meta = srcMeta[s] || FALLBACK_SOURCES[s];
            const on = show[s];
            return (
              <button
                key={s}
                className={`toggle ${on ? 'on' : 'off'}`}
                style={on ? { borderColor: meta.color, color: meta.color } : {}}
                onClick={() => toggle(s)}
                title={`Toggle ${meta.label}`}
              >
                <span>{meta.emoji}</span> {meta.label}
                <span className="count">{counts[s]}</span>
              </button>
            );
          })}
        </div>

        <div className={`conn conn-${status}`}>
          <span className="dot" /> {status.toUpperCase()}
          {config && config.demo ? <span className="demo-pill">DEMO</span> : null}
        </div>
      </header>

      <div
        className="feed"
        ref={feedRef}
        onScroll={onScroll}
        onMouseEnter={() => (hoveringRef.current = true)}
        onMouseLeave={() => (hoveringRef.current = false)}
      >
        {visible.length === 0 ? (
          <div className="empty">Waiting for messages…</div>
        ) : (
          visible.map((m) => {
            const meta = srcMeta[m.source] || FALLBACK_SOURCES[m.source] || { label: m.source, emoji: '•', color: '#888' };
            return (
              <div className="row" key={m.id}>
                <span className="ts">{fmtTime(m.ts)}</span>
                <Badge meta={meta} />
                <span className="channel">#{m.channel}</span>
                <span
                  className="author"
                  style={{ color: m.color || meta.color }}
                >
                  {m.author}
                </span>
                <span className="text">{m.text}</span>
              </div>
            );
          })
        )}
      </div>

      {!autoScroll && (
        <button
          className="jump"
          onClick={() => {
            setAutoScroll(true);
            const el = feedRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          ↓ Jump to live
        </button>
      )}

      <footer className="statusbar">
        <span>{messages.length} retained</span>
        <span>·</span>
        <span>{visible.length} shown</span>
        {config && !config.demo && (
          <>
            <span>·</span>
            <span>
              live: {config.twitch?.length || 0} twitch / {config.kick?.length || 0} kick / {config.x ? '1' : '0'} x
            </span>
          </>
        )}
      </footer>
    </div>
  );
}
