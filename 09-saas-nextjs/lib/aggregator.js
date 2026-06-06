// ---------------------------------------------------------------------------
// Per-room aggregator. One instance per room id, kept in a global registry so
// it survives Next.js dev hot-reload. Runs the connectors, persists messages to
// the db (deduped, capped retention), and fans out live to SSE subscribers.
// ---------------------------------------------------------------------------
const { prisma } = require("./prisma");
const {
  startTwitch,
  startKick,
  startX,
  startDemo,
} = require("./connectors");

const MAX_PERSIST = 500; // cap retained messages per room in db
const RING = 200; // in-memory ring for instant SSE replay on connect

const g = globalThis;
g.__omnichatAggs = g.__omnichatAggs || new Map();

function log(roomId, msg) {
  // keep noise low but useful in dev
  console.log("[room " + roomId.slice(0, 6) + "] " + msg);
}

function csv(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

class RoomAggregator {
  constructor(room) {
    this.room = room;
    this.stops = [];
    this.subscribers = new Set(); // each: fn(msg)
    this.recent = []; // ring buffer of recent unified messages
    this.pruneCounter = 0;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const r = this.room;
    const onMessage = (m) => this.handle(m);

    const twitch = csv(r.twitch);
    const kick = csv(r.kick);
    const hasX = !!(r.xMode && r.xTarget && process.env.X_BEARER_TOKEN);
    const anyReal = twitch.length || kick.length || hasX;

    if (twitch.length)
      this.stops.push(startTwitch(twitch, onMessage, (s) => log(r.id, s)));
    if (kick.length)
      this.stops.push(
        startKick(kick, r.kickIds, onMessage, (s) => log(r.id, s))
      );
    if (hasX)
      this.stops.push(
        startX(r.xMode, r.xTarget, process.env.X_BEARER_TOKEN, onMessage, (s) =>
          log(r.id, s)
        )
      );

    // Demo if explicitly flagged, or if no real source is configured.
    if (r.demo || process.env.DEMO === "1" || !anyReal) {
      log(r.id, "demo mode active");
      this.stops.push(startDemo(onMessage));
    }
    log(r.id, "aggregator started");
  }

  async handle(m) {
    // in-memory ring for live + instant replay
    this.recent.push(m);
    if (this.recent.length > RING) this.recent.shift();

    // fan out to live subscribers
    for (const sub of this.subscribers) {
      try { sub(m); } catch (e) {}
    }

    // persist (best-effort; never let a db error kill the stream)
    try {
      await prisma.message.create({
        data: {
          roomId: this.room.id,
          msgId: m.id,
          source: m.source,
          channel: m.channel,
          author: m.author,
          text: m.text,
          color: m.color || "",
          ts: BigInt(m.ts),
        },
      });
    } catch (e) {
      // ignore unique/transient errors
    }

    // periodic retention prune
    this.pruneCounter++;
    if (this.pruneCounter % 50 === 0) this.prune();
  }

  async prune() {
    try {
      const keep = await prisma.message.findMany({
        where: { roomId: this.room.id },
        orderBy: { ts: "desc" },
        take: MAX_PERSIST,
        select: { id: true },
      });
      const keepIds = keep.map((k) => k.id);
      if (keepIds.length >= MAX_PERSIST) {
        await prisma.message.deleteMany({
          where: { roomId: this.room.id, id: { notIn: keepIds } },
        });
      }
    } catch (e) {}
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  getRecent() {
    return this.recent.slice();
  }
}

async function getAggregator(roomId) {
  let agg = g.__omnichatAggs.get(roomId);
  if (agg) return agg;
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) return null;
  agg = new RoomAggregator(room);
  g.__omnichatAggs.set(roomId, agg);
  agg.start();
  return agg;
}

// Boot every existing room's aggregator (called once at startup / first hit).
async function bootAllRooms() {
  if (g.__omnichatBooted) return;
  g.__omnichatBooted = true;
  try {
    const rooms = await prisma.room.findMany();
    for (const room of rooms) {
      if (!g.__omnichatAggs.has(room.id)) {
        const agg = new RoomAggregator(room);
        g.__omnichatAggs.set(room.id, agg);
        agg.start();
      }
    }
  } catch (e) {
    console.error("bootAllRooms error", e.message);
  }
}

module.exports = { getAggregator, bootAllRooms, RoomAggregator };
