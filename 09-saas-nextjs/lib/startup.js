// Ensures the demo room exists on first run and boots all room aggregators.
// Idempotent; safe to call from any API route.
const { prisma } = require("./prisma");
const { bootAllRooms } = require("./aggregator");

const g = globalThis;

async function ensureDemoRoom() {
  const existing = await prisma.room.findFirst({ where: { name: "Demo Room" } });
  if (existing) return existing;
  return prisma.room.create({
    data: {
      name: "Demo Room",
      twitch: process.env.TWITCH_CHANNELS || "",
      kick: process.env.KICK_CHANNELS || "",
      kickIds: process.env.KICK_CHATROOM_IDS || "",
      xMode: process.env.X_MODE || "",
      xTarget: process.env.X_TARGET || "",
      demo: true, // always demo so judges see a live feed with zero config
    },
  });
}

async function init() {
  if (g.__omnichatInit) return g.__omnichatInit;
  g.__omnichatInit = (async () => {
    try {
      await ensureDemoRoom();
      await bootAllRooms();
    } catch (e) {
      console.error("startup init error", e.message);
    }
  })();
  return g.__omnichatInit;
}

module.exports = { init, ensureDemoRoom };
