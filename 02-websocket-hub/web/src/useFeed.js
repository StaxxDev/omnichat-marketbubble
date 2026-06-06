import { useEffect, useRef, useState, useCallback } from 'react';

const MAX_RETAINED = 500;

// Connects to the server WebSocket, merges messages, reconnects with backoff,
// and caps retained messages to bound memory.
export function useFeed() {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('connecting'); // connecting | open | closed
  const [sources, setSources] = useState(null);
  const [config, setConfig] = useState(null);

  const wsRef = useRef(null);
  const attemptRef = useRef(0);
  const closedRef = useRef(false);
  const seenRef = useRef(new Set());

  const addMessages = useCallback((incoming) => {
    setMessages((prev) => {
      const next = prev.slice();
      for (const m of incoming) {
        if (seenRef.current.has(m.id)) continue;
        seenRef.current.add(m.id);
        next.push(m);
      }
      if (next.length > MAX_RETAINED) {
        const drop = next.splice(0, next.length - MAX_RETAINED);
        for (const d of drop) seenRef.current.delete(d.id);
      }
      return next;
    });
  }, []);

  const connect = useCallback(() => {
    if (closedRef.current) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;
    setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      setStatus('open');
    };

    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (frame.type === 'hello') {
        if (frame.sources) setSources(frame.sources);
        if (frame.config) setConfig(frame.config);
        if (Array.isArray(frame.history)) addMessages(frame.history);
      } else if (frame.type === 'message' && frame.message) {
        addMessages([frame.message]);
      }
    };

    ws.onclose = () => {
      setStatus('closed');
      scheduleReconnect();
    };

    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }, [addMessages]);

  const scheduleReconnect = useCallback(() => {
    if (closedRef.current) return;
    attemptRef.current += 1;
    const wait = Math.min(15000, 500 * 2 ** Math.min(attemptRef.current, 5));
    setTimeout(connect, wait);
  }, [connect]);

  useEffect(() => {
    closedRef.current = false;
    connect();
    return () => {
      closedRef.current = true;
      try { wsRef.current && wsRef.current.close(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { messages, status, sources, config };
}
