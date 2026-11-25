export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ service: "RustyStatus", status: "online" });
    }

    if (url.pathname !== "/api/v1/heartbeat" || request.method !== "POST") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (request.headers.get("Authorization") !== `Bearer ${env.API_KEY}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof payload.node !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(payload.node)) {
      return Response.json({ error: "Invalid node" }, { status: 400 });
    }

    const now = new Date().toISOString();

    const previous = await env.DB.prepare(
      "SELECT offline_alerted FROM nodes WHERE node = ?"
    ).bind(payload.node).first();

    await env.DB.prepare(`
      INSERT INTO nodes (node, last_seen, offline_alerted)
      VALUES (?, ?, 0)
      ON CONFLICT(node) DO UPDATE SET last_seen = excluded.last_seen
    `).bind(payload.node, now).run();

    if (previous?.offline_alerted === 1) {
      await sendDiscord(env, `🟢 **${payload.node} RECOVERED**\nHeartbeat restored.`);

      await env.DB.prepare(
        "UPDATE nodes SET offline_alerted = 0 WHERE node = ?"
      ).bind(payload.node).run();
    }

    return Response.json({ received: true, node: payload.node, timestamp: now });
  },

  async scheduled(controller, env, ctx) {
    const nodes = await env.DB.prepare(
      "SELECT node, last_seen, offline_alerted FROM nodes"
    ).all();

    for (const node of nodes.results) {
      const elapsed = Date.now() - Date.parse(node.last_seen);

      if (elapsed > 90000 && node.offline_alerted === 0) {
        const message =
          `🔴 **${node.node} OFFLINE**\nNo heartbeat received for ${Math.floor(elapsed / 1000)} seconds.`;

        // Only mark offline after Discord accepts the notification.
        await sendDiscord(env, message);

        await env.DB.prepare(
          "UPDATE nodes SET offline_alerted = 1 WHERE node = ?"
        ).bind(node.node).run();
      }
    }
  }
};

async function sendDiscord(env, message) {
  const response = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message })
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status}`);
  }
}
