import { NextResponse } from "next/server";
const { prisma } = require("../../../lib/prisma");
const { init } = require("../../../lib/startup");
const { getAggregator } = require("../../../lib/aggregator");

export const dynamic = "force-dynamic";

export async function GET() {
  await init();
  const rooms = await prisma.room.findMany({
    orderBy: { createdAt: "desc" },
  });
  const out = [];
  for (const r of rooms) {
    const count = await prisma.message.count({ where: { roomId: r.id } });
    out.push({
      id: r.id,
      name: r.name,
      twitch: r.twitch,
      kick: r.kick,
      xMode: r.xMode,
      xTarget: r.xTarget,
      demo: r.demo,
      messageCount: count,
      createdAt: r.createdAt,
    });
  }
  return NextResponse.json({ rooms: out });
}

export async function POST(req) {
  await init();
  let body = {};
  try {
    body = await req.json();
  } catch (e) {}
  const name = (body.name || "").trim() || "Untitled Room";
  const twitch = (body.twitch || "").trim();
  const kick = (body.kick || "").trim();
  const kickIds = (body.kickIds || "").trim();
  const xMode = (body.xMode || "").trim();
  const xTarget = (body.xTarget || "").trim();
  const demo = !!body.demo;

  const room = await prisma.room.create({
    data: { name, twitch, kick, kickIds, xMode, xTarget, demo },
  });
  // boot the aggregator immediately
  await getAggregator(room.id);
  return NextResponse.json({ room });
}
