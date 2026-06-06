const { init } = require("../../../../../lib/startup");
const { getAggregator } = require("../../../../../lib/aggregator");

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-Sent Events: streams live unified messages for a room. On connect we
// replay the in-memory ring so the viewer sees immediate activity, then push
// every new message as it arrives from the room's connectors.
export async function GET(req, { params }) {
  await init();
  const agg = await getAggregator(params.id);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      function send(obj) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));
        } catch (e) {
          closed = true;
        }
      }

      if (!agg) {
        send({ type: "error", error: "room not found" });
        controller.close();
        return;
      }

      // hello + replay recent ring
      send({ type: "hello", roomId: params.id });
      for (const m of agg.getRecent()) send({ type: "msg", message: m });

      const unsub = agg.subscribe((m) => send({ type: "msg", message: m }));

      // keepalive comment every 20s so proxies don't drop the connection
      const ka = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch (e) {
          closed = true;
        }
      }, 20000);

      const onAbort = () => {
        closed = true;
        clearInterval(ka);
        unsub();
        try { controller.close(); } catch (e) {}
      };
      req.signal.addEventListener("abort", onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
