/**
 * A stand-in for the vue-automation Next app's /api/internal surface.
 *
 * The connector owns no lighting logic — it relays what the app says — so the
 * only way to test the connector's half honestly is to put a controllable app
 * behind it. This is not a mock of the connector's own behaviour; it is the
 * far side of the wire, and it asserts the contract in both directions: every
 * request must carry the shared secret, and the connector must relay the app's
 * verdict without softening it.
 *
 * Not named `*.test.mjs`, so `node --test tests/*.test.mjs` never runs it.
 */
import { createServer } from "node:http";

export const SECRET = "test-internal-secret";

/**
 * @param routes  map of "METHOD /path" → (body, url) => [status, json]
 * @returns { url, close, requests }
 */
export async function startFakeApp(routes) {
  const requests = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }

    const url = new URL(req.url, "http://internal");
    requests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      body,
      secret: req.headers["x-internal-secret"] ?? null,
    });

    // The real guard fails closed on a missing or wrong secret, and every
    // internal route calls it first. Reproduced here so a connector that
    // forgets the header fails the test rather than passing quietly.
    if (req.headers["x-internal-secret"] !== SECRET) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `fake app has no route for ${key}` }));
      return;
    }

    const [status, payload] = await handler(body, url);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  // Read at call time by the connector, so setting them here is enough.
  process.env.APP_INTERNAL_URL = `http://127.0.0.1:${port}`;
  process.env.MCP_INTERNAL_SECRET = SECRET;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Four lamps, one of them dark because someone hit the wall switch. */
export function lampFixture() {
  return [
    {
      entityId: "light.shelf_lamp", name: "Shelf lamp", reachable: true, on: true,
      brightness: 40, kelvin: 2700, minKelvin: 2000, maxKelvin: 6493,
      rgb: null, hs: null, supportsColor: true, colorMode: "color_temp",
      room: "living",
    },
    {
      entityId: "light.floor_lamp", name: "Floor lamp", reachable: false, on: false,
      brightness: null, kelvin: null, minKelvin: 2000, maxKelvin: 6493,
      rgb: null, hs: null, supportsColor: true, colorMode: null,
      room: "unassigned",
    },
  ];
}

export function sceneFixture() {
  return [
    {
      entityId: "scene.cozy_cinema", name: "Cozy Cinema", id: "cozy_cinema_1754600000",
      label: "Cozy Cinema", accent: "#e8a54d", sortOrder: 0, tapCount: 12,
      lastActivated: "2026-08-13T21:04:00+00:00", lastTappedAt: "2026-08-13T21:04:00.000Z",
      aliases: ["movie mode", "film night"],
    },
  ];
}

export function stateFixture(overrides = {}) {
  return {
    ok: true,
    read_at: new Date().toISOString(),
    scenes: sceneFixture(),
    lamps: lampFixture(),
    automations: [
      {
        entityId: "automation.evening_lights", name: "Evening lights",
        id: "vue_1754600001", enabled: true, lastTriggered: null,
      },
    ],
    unreachableCount: 1,
    metadata: "ok",
    rooms: [
      { id: "living", name: "Living Room" },
      { id: "bedroom", name: "Bedroom" },
      { id: "unassigned", name: "Unassigned" },
    ],
    room_overrides: {},
    ...overrides,
  };
}
