import { NextResponse } from "next/server";
const { prisma } = require("../../../../../lib/prisma");
const { init } = require("../../../../../lib/startup");

export const dynamic = "force-dynamic";

// Returns persisted messages (most recent up to `limit`), in chronological order.
export async function GET(req, { params }) {
  await init();
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 500);

  const rows = await prisma.message.findMany({
    where: { roomId: params.id },
    orderBy: { ts: "desc" },
    take: limit,
  });
  // reverse to chronological (oldest first)
  const messages = rows
    .map((r) => ({
      id: r.msgId,
      source: r.source,
      channel: r.channel,
      author: r.author,
      text: r.text,
      color: r.color,
      ts: Number(r.ts),
    }))
    .reverse();

  return NextResponse.json({ messages });
}
