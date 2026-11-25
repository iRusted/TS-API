
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({
        service: "RustyStatus",
        status: "online"
      });
    }

    // Heartbeat endpoint
    if (
      url.pathname !== "/api/v1/heartbeat" ||
      request.method !== "POST"
    ) {
      return Response.json(
        { error: "Not found" },
        { status: 404 }
      );
    }

    // Authentication
    if (
      request.headers.get("Authorization") !==
      `Bearer ${env.API_KEY}`
    ) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Parse request
    let payload;

    try {
      payload = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid JSON" },
        { status: 400 }
      );
    }

    // Validate node name
    if (
      typeof payload.node !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(payload.node)
    ) {
      return Response.json(
        { error: "Invalid node" },
        { status: 400 }
      );
    }

    const now = new Date();
    const timestamp = now.toISOString();

    // Get previous node state
    const previous = await env.DB.prepare(
      `SELECT offline_alerted, last_discord_heartbeat
       FROM nodes WHERE node = ?`
    ).bind(payload.node).first();

    // Update heartbeat timestamp
    await env.DB.prepare(`
      INSERT INTO nodes (node, last_seen, offline_alerted)
      VALUES (?, ?, 0)
      ON CONFLICT(node) DO UPDATE SET
        last_seen = excluded.last_seen
    `).bind(payload.node, timestamp).run();

    // Recovery notification
    if (previous?.offline_alerted === 1) {
      await sendDiscord(
        env.DISCORD_WEBHOOK_URL,
        `🟢 **${payload.node} RECOVERED**\nHeartbeat restored.`,
        false,
        false
      );

      await env.DB.prepare(
        `UPDATE nodes
         SET offline_alerted = 0
         WHERE node = ?`
      ).bind(payload.node).run();
    }

    // Heartbeat notification (once every 60 seconds)
    const lastHeartbeat = previous?.last_discord_heartbeat
      ? Date.parse(previous.last_discord_heartbeat)
      : 0;

    if (Date.now() - lastHeartbeat >= 60000) {
      await sendDiscord(
        env.HEART_WEBHOOK_URL,
        `💓 **${payload.node}** — heartbeat received.`,
        true,
        false
      );

      await env.DB.prepare(
        `UPDATE nodes
         SET last_discord_heartbeat = ?
         WHERE node = ?`
      ).bind(timestamp, payload.node).run();
    }

    return Response.json({
      received: true,
      node: payload.node,
      timestamp
    });
  },

  // Scheduled offline detection
  async scheduled(controller, env, ctx) {
    const nodes = await env.DB.prepare(
      `SELECT node, last_seen, offline_alerted
       FROM nodes`
    ).all();

    for (const node of nodes.results) {
      const elapsed = Date.now() - Date.parse(node.last_seen);

      // Node offline after 90 seconds
      if (elapsed > 90000 && node.offline_alerted === 0) {
        await sendDiscord(
          env.DISCORD_WEBHOOK_URL,
          `@everyone 🔴 **${node.node} OFFLINE**\nNo heartbeat received for ${Math.floor(elapsed / 1000)} seconds.`,
          false,
          true
        );

        await env.DB.prepare(
          `UPDATE nodes
           SET offline_alerted = 1
           WHERE node = ?`
        ).bind(node.node).run();
      }
    }
  }
};

// Discord webhook helper
async function sendDiscord(
  webhookUrl,
  message,
  silent = false,
  allowEveryone = false
) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: message,

      // Discord SUPPRESS_NOTIFICATIONS flag
      flags: silent ? 4096 : 0,

      allowed_mentions: {
        parse: allowEveryone ? ["everyone"] : []
      }
    })
  });

  if (!response.ok) {
    throw new Error(
      `Discord webhook failed: ${response.status}`
    );
  }
}
