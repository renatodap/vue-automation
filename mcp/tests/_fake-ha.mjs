/**
 * A stand-in for Home Assistant: the WebSocket registries and the REST service
 * surface, on one port, exactly as the real instance presents them.
 *
 * Home Assistant is the PRIMARY path for the four Zigbee tools — the broker's
 * credentials live behind the Supervisor and cannot be reached from the
 * connector — so a test that mocks the connector's own functions would prove
 * nothing about the thing that broke. This is the far side of the wire instead:
 * `config/device_registry/list` and `config/entity_registry/list` over
 * `/api/websocket`, `config/entity_registry/update` as a real command that can
 * be made to fail, and `POST /api/services/mqtt/publish` recording exactly what
 * was published.
 *
 * Not named `*.test.mjs`, so `node --test tests/*.test.mjs` never runs it.
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export const HA_TOKEN = "test-ha-admin-token";

/**
 * @param {object} opts
 *   devices   – device registry rows (mutable through the returned handle)
 *   entities  – entity registry rows
 *   failEntityUpdate – message to refuse `config/entity_registry/update` with
 *   failPublish      – [status, body] to answer mqtt.publish with
 * @returns handle with { url, published, renames, setDevices, setEntities, close }
 */
export async function startFakeHa(opts = {}) {
  let devices = opts.devices ?? [];
  let entities = opts.entities ?? [];
  const published = [];
  const renames = [];
  const state = { failEntityUpdate: opts.failEntityUpdate ?? null, failPublish: opts.failPublish ?? null };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url, "http://ha");

    if (req.headers.authorization !== `Bearer ${HA_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/services/mqtt/publish") {
      const body = raw ? JSON.parse(raw) : {};
      published.push(body);
      if (state.failPublish) {
        const [status, payload] = state.failPublish;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/states/")) {
      const entityId = decodeURIComponent(url.pathname.slice("/api/states/".length));
      const value = (opts.states ?? {})[entityId];
      if (value === undefined) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Entity not found." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entity_id: entityId, state: value }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: `no route for ${req.method} ${url.pathname}` }));
  });

  // The connector derives ws:// from HA_BASE_URL and appends /api/websocket.
  const wss = new WebSocketServer({ server, path: "/api/websocket" });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.8.0" }));
    socket.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "auth") {
        socket.send(JSON.stringify({ type: msg.access_token === HA_TOKEN ? "auth_ok" : "auth_invalid" }));
        return;
      }
      const ok = (result) => socket.send(JSON.stringify({ id: msg.id, type: "result", success: true, result }));
      const fail = (message) =>
        socket.send(JSON.stringify({ id: msg.id, type: "result", success: false, error: { code: "x", message } }));

      switch (msg.type) {
        case "config/device_registry/list":
          return ok(devices);
        case "config/entity_registry/list":
          return ok(entities);
        case "config/entity_registry/update": {
          if (state.failEntityUpdate) return fail(state.failEntityUpdate);
          renames.push({ entity_id: msg.entity_id, name: msg.name });
          const row = entities.find((e) => e.entity_id === msg.entity_id);
          if (row) row.name = msg.name;
          return ok({ entity_entry: row ?? null });
        }
        default:
          return fail(`fake HA does not implement ${msg.type}`);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  // Read at call time by the connector, so setting them here is enough.
  process.env.HA_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.HA_TOKEN = HA_TOKEN;

  return {
    url: `http://127.0.0.1:${port}`,
    published,
    renames,
    get devices() {
      return devices;
    },
    setDevices: (next) => {
      devices = next;
    },
    setEntities: (next) => {
      entities = next;
    },
    failEntityUpdate: (message) => {
      state.failEntityUpdate = message;
    },
    failPublish: (spec) => {
      state.failPublish = spec;
    },
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A z2m bridge plus two bulbs, as Home Assistant's device registry holds them. */
export function deviceFixture() {
  return [
    {
      id: "dev-bridge",
      name: "Zigbee2MQTT Bridge",
      name_by_user: null,
      manufacturer: "Zigbee2MQTT",
      model: "Bridge",
      identifiers: [["mqtt", "zigbee2mqtt_bridge_0x00124b0099887766"]],
      connections: [],
      via_device_id: null,
      disabled_by: null,
    },
    {
      id: "dev-shelf",
      name: "Shelf lamp",
      name_by_user: null,
      manufacturer: "IKEA",
      model: "LED2003G10",
      identifiers: [["mqtt", "zigbee2mqtt_0x00124b0022a1b2c3"]],
      connections: [],
      via_device_id: "dev-bridge",
      disabled_by: null,
    },
    {
      id: "dev-floor",
      name: "0x00124b0022ffeedd",
      name_by_user: null,
      manufacturer: "IKEA",
      model: "LED2003G10",
      identifiers: [["mqtt", "zigbee2mqtt_0x00124b0022ffeedd"]],
      connections: [],
      via_device_id: "dev-bridge",
      disabled_by: null,
    },
    // Not Zigbee at all, and must never be reported as a mesh device.
    {
      id: "dev-sun",
      name: "Sun",
      name_by_user: null,
      manufacturer: null,
      model: null,
      identifiers: [["sun", "sun"]],
      connections: [],
      via_device_id: null,
      disabled_by: null,
    },
  ];
}

export function entityFixture() {
  return [
    {
      entity_id: "light.shelf_lamp", name: null, original_name: "Shelf lamp",
      platform: "mqtt", unique_id: "0x00124b0022a1b2c3_light_zigbee2mqtt", device_id: "dev-shelf",
    },
    {
      entity_id: "sensor.shelf_lamp_linkquality", name: null, original_name: "Linkquality",
      platform: "mqtt", unique_id: "0x00124b0022a1b2c3_linkquality_zigbee2mqtt", device_id: "dev-shelf",
    },
    {
      entity_id: "light.0x00124b0022ffeedd", name: null, original_name: "0x00124b0022ffeedd",
      platform: "mqtt", unique_id: "0x00124b0022ffeedd_light_zigbee2mqtt", device_id: "dev-floor",
    },
    {
      entity_id: "switch.zigbee2mqtt_bridge_permit_join", name: null, original_name: "Permit join",
      platform: "mqtt", unique_id: "bridge_0x00124b0099887766_permit_join", device_id: "dev-bridge",
    },
  ];
}

/** A third bulb, as it looks the moment its interview finishes. */
export function newlyJoinedDevice() {
  return {
    id: "dev-new",
    name: "0x00124b0022aabbcc",
    name_by_user: null,
    manufacturer: "IKEA",
    model: "LED2003G10",
    identifiers: [["mqtt", "zigbee2mqtt_0x00124b0022aabbcc"]],
    connections: [],
    via_device_id: "dev-bridge",
    disabled_by: null,
  };
}

export function newlyJoinedEntity() {
  return {
    entity_id: "light.0x00124b0022aabbcc", name: null, original_name: "0x00124b0022aabbcc",
    platform: "mqtt", unique_id: "0x00124b0022aabbcc_light_zigbee2mqtt", device_id: "dev-new",
  };
}
