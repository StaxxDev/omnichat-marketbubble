import { NextResponse } from "next/server";
const { prisma } = require("../../../../lib/prisma");
const { init } = require("../../../../lib/startup");

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  await init();
  const room = await prisma.room.findUnique({ where: { id: params.id } });
  if (!room) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    room: {
      id: room.id,
      name: room.name,
      twitch: room.twitch,
      kick: room.kick,
      xMode: room.xMode,
      xTarget: room.xTarget,
      demo: room.demo,
    },
  });
}
