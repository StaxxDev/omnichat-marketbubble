// OmniChat Edge — Cloudflare Worker entry.
//
// Routing:
//   GET /ws       -> WebSocket upgrade, proxied to the single Hub Durable Object.
//   GET /healthz  -> liveness probe.
//   everything else -> static assets (public/index.html UI).
//
// A single Durable Object instance ("hub") is the fan-in point: it owns the
// upstream Twitch/Kick WebSockets and the X poll alarm, and fans out unified
// messages to every connected browser WebSocket.

export { Hub } from "./hub.js";

// One global hub keeps all browsers and all upstreams in a single place.
const HUB_NAME = "global";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const id = env.HUB.idFromName(HUB_NAME);
      const stub = env.HUB.get(id);
      return stub.fetch(request);
    }

    // Static UI. The [assets] binding serves public/ automatically, but we
    // fall back to a hand-served index if the binding is absent (older setups).
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
