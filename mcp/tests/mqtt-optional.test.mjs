/**
 * MQTT is enrichment. A broker that refuses must cost nothing.
 *
 * ## The failure this pins
 *
 * `MQTT_URL` is still set on the deployed connector and the broker still
 * refuses it — the credentials are held in the Zigbee2MQTT / Mosquitto add-on
 * configuration behind Home Assistant's Supervisor, which will not hand them
 * over to any token this service can hold. That is not a state to be fixed; it
 * is the state to be survived.
 *
 * So the contract is: a configured-but-unreachable broker must produce a
 * boolean, not an exception. `tryConnect()` never rejects, a failure is
 * remembered so it is not re-attempted on every call, and every Zigbee tool
 * keeps working through Home Assistant with the broker-only fields reported as
 * unknown. A thrown error here would take down four tools and, at boot, log a
 * warning on a service that is working correctly.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { startFakeHa, deviceFixture, entityFixture } from "./_fake-ha.mjs";

delete process.env.DATABASE_URL;

/** A port nothing is listening on, so the connect is refused immediately. */
async function closedPort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

let ha;

before(async () => {
  ha = await startFakeHa({ devices: deviceFixture(), entities: entityFixture() });
  process.env.MQTT_URL = `mqtt://127.0.0.1:${await closedPort()}`;
});

after(async () => {
  const { closeMqtt } = await import("../dist/mqtt.js");
  await closeMqtt();
  await ha.close();
});

const call = (name, args = {}) =>
  import("../dist/rpc.js").then(({ handleRpc }) =>
    handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));

test("a broker that refuses answers false — it does not throw", async () => {
  const { tryConnect } = await import("../dist/mqtt.js");
  assert.equal(await tryConnect(), false, "an optional subsystem reports availability, it does not raise");
  // And again: the second call must be the remembered failure rather than a
  // fresh nine-second attempt bolted onto every tool call after it.
  const startedAt = Date.now();
  assert.equal(await tryConnect(), false);
  assert.ok(
    Date.now() - startedAt < 500,
    "a failed connect must be remembered — otherwise every call pays for the broker being down",
  );
});

test("the Zigbee tools work with MQTT_URL set and the broker refusing", async () => {
  const list = await call("list_zigbee_devices");
  assert.equal(list.error, undefined);
  assert.equal(
    list.result.isError, false,
    `list_zigbee_devices failed: ${list.result.content?.[0]?.text ?? ""}`,
  );
  assert.equal(list.result.structuredContent.enrichment, "unavailable");
  assert.equal(
    list.result.structuredContent.devices.length, 3,
    "the mesh comes from Home Assistant, so an unreachable broker changes nothing about it",
  );

  ha.published.length = 0;
  const pairing = await call("start_pairing", { seconds: 60 });
  assert.equal(pairing.result.isError, false);
  assert.equal(ha.published[0].topic, "zigbee2mqtt/bridge/request/permit_join");
  assert.equal(
    pairing.result.structuredContent.zigbee2mqtt.confirmed, false,
    "with no subscription there is no acknowledgement, and the result must not pretend otherwise",
  );
});

test("poll_pairing distinguishes 'not listening' from 'nothing happened'", async () => {
  const res = await call("poll_pairing");
  assert.equal(res.result.isError, false);
  assert.equal(
    res.result.structuredContent.bridge_events, null,
    "null is 'the broker is not being listened to'; [] would claim the broker was watched and silent",
  );
});
