/**
 * The four Zigbee tools must work with the MQTT broker ENTIRELY ABSENT.
 *
 * ## The failure this pins
 *
 * The connector used to open a direct connection to Mosquitto on the Pi, and it
 * failed at boot with `Connection refused: Not authorized`. Those credentials
 * are not obtainable: they live in the Mosquitto / Zigbee2MQTT add-on
 * configuration behind Home Assistant's Supervisor, `/api/hassio/*` refuses a
 * long-lived token with HTTP 401, and Home Assistant never exposes a config
 * entry's `data`. So every one of the four tools failed permanently, and no
 * amount of retrying was ever going to fix it.
 *
 * Home Assistant is authenticated to that broker already, so it is the bridge:
 * the device registry IS the mesh, and `mqtt.publish` IS the way onto it. This
 * file runs every one of the four tools with `MQTT_URL` unset — the deployed
 * reality — and asserts that none of them errors, that the bridge requests go
 * out through `mqtt.publish` on the right topics, that a device appearing in
 * the registry is what `poll_pairing` reports, and that `name_device` still
 * runs BOTH halves and reports `fully_renamed` honestly when only one lands.
 *
 * Needs no database, no broker and no Home Assistant: the far side of the wire
 * is a controllable fake HA (tests/_fake-ha.mjs).
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  startFakeHa, deviceFixture, entityFixture, newlyJoinedDevice, newlyJoinedEntity,
} from "./_fake-ha.mjs";

delete process.env.DATABASE_URL;
// The whole point: the broker is not there, and nothing may depend on it.
delete process.env.MQTT_URL;
delete process.env.MQTT_USERNAME;
delete process.env.MQTT_PASSWORD;

const { handleRpc } = await import("../dist/rpc.js");
const { clearPairingSnapshot } = await import("../dist/zigbee.js");

let ha;

const call = (name, args = {}) =>
  handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

/** The structured result, with a readable assertion when the tool errored. */
function ok(res, label) {
  assert.equal(res.error, undefined, `${label} came back as a protocol error`);
  assert.equal(
    res.result.isError,
    false,
    `${label} failed: ${res.result.content?.[0]?.text ?? "(no text)"}`,
  );
  return res.result.structuredContent;
}

before(async () => {
  ha = await startFakeHa({
    devices: deviceFixture(),
    entities: entityFixture(),
    states: { "switch.zigbee2mqtt_bridge_permit_join": "off" },
  });
});

beforeEach(() => {
  ha.setDevices(deviceFixture());
  ha.setEntities(entityFixture());
  ha.failEntityUpdate(null);
  ha.failPublish(null);
  ha.published.length = 0;
  ha.renames.length = 0;
  clearPairingSnapshot();
});

after(async () => {
  await ha.close();
});

// ------------------------------------------------------------ list_zigbee_devices

test("list_zigbee_devices builds the mesh from the HA device registry, with no broker", async () => {
  const data = ok(await call("list_zigbee_devices"), "list_zigbee_devices");

  assert.equal(data.source, "home_assistant_device_registry");
  assert.equal(data.enrichment, "unavailable", "there is no broker, and it must say so rather than fail");

  const ieee = data.devices.map((d) => d.ieee_address).sort();
  assert.deepEqual(
    ieee,
    ["0x00124b0022a1b2c3", "0x00124b0022ffeedd", "0x00124b0099887766"],
    "every Zigbee device must be found by the IEEE address inside its identifiers",
  );
  assert.equal(
    data.devices.some((d) => d.friendly_name === "Sun"), false,
    "a non-Zigbee device carries no IEEE address and must never be reported as a mesh device",
  );

  const shelf = data.devices.find((d) => d.ieee_address === "0x00124b0022a1b2c3");
  assert.deepEqual(
    shelf.entities, ["light.shelf_lamp", "sensor.shelf_lamp_linkquality"],
    "entities join to the device on device_id, not on a unique_id substring guess",
  );
  assert.equal(shelf.primary_entity, "light.shelf_lamp", "a person means the light, not its linkquality sensor");

  // Null is "unknown". Reporting a bulb as un-interviewed because the broker
  // was unreadable would be a fact the connector does not have.
  assert.equal(shelf.interview_completed, null);
  assert.equal(shelf.supported, null);
  assert.match(data.note, /null \(unknown\)/, "the note must warn the model not to read null as false");

  // The bridge is in the registry too and is not a bulb.
  assert.equal(data.devices.find((d) => d.ieee_address === "0x00124b0099887766").is_coordinator, true);
  assert.equal(data.device_count, 2, "the coordinator must not be counted as a device");
});

test("pairing_open is read from the permit-join entity when the broker cannot answer", async () => {
  const data = ok(await call("list_zigbee_devices"), "list_zigbee_devices");
  assert.equal(data.pairing_open, false, "z2m publishes a permit-join switch through HA discovery");
});

// ------------------------------------------------------------------ start_pairing

test("start_pairing publishes permit_join through HA's mqtt.publish service", async () => {
  ha.setState("switch.zigbee2mqtt_bridge_permit_join", "on");
  const data = ok(await call("start_pairing", { seconds: 120 }), "start_pairing");

  assert.equal(ha.published.length, 1, "exactly one publish, through Home Assistant");
  const [publish] = ha.published;
  assert.equal(publish.topic, "zigbee2mqtt/bridge/request/permit_join");
  const payload = JSON.parse(publish.payload);
  assert.equal(payload.time, 120, "z2m takes the window in seconds as `time`");
  assert.ok(payload.transaction, "a transaction id costs nothing and is what makes a response readable");

  assert.equal(data.open_for_seconds, 120);
  assert.equal(data.zigbee2mqtt.via, "home_assistant_mqtt_publish");
  assert.equal(
    data.zigbee2mqtt.confirmed, false,
    "nothing is subscribed to bridge/response, so the result must say unconfirmed rather than claim success",
  );
  assert.match(data.next, /poll_pairing/, "the model must be routed to the asynchronous half");
});

test("start_pairing clamps the window to Zigbee's 254-second ceiling", async () => {
  ha.setState("switch.zigbee2mqtt_bridge_permit_join", "on");
  const data = ok(await call("start_pairing", { seconds: "9999" }), "start_pairing");

  // 254 is the PROTOCOL's ceiling, not a policy choice: the Zigbee permit-join
  // duration is an 8-bit field. This was capped at 600 once, and a request for
  // 300 was rejected by Zigbee2MQTT SILENTLY — the publish succeeded, the mesh
  // stayed shut, and the tool reported ok. Someone spent the window resetting a
  // bulb into a mesh that was never open.
  assert.equal(data.open_for_seconds, 254, "the window is capped at Zigbee's own limit");
  assert.equal(JSON.parse(ha.published[0].payload).time, 254, "and z2m is never asked for more");
});

test("start_pairing(0) closes the mesh again", async () => {
  ha.setState("switch.zigbee2mqtt_bridge_permit_join", "off");
  const data = ok(await call("start_pairing", { seconds: 0 }), "start_pairing");
  assert.equal(JSON.parse(ha.published[0].payload).time, 0);
  assert.match(data.next, /closed/i);
});

test("start_pairing proves the mesh opened by reading the permit-join switch", async () => {
  ha.setState("switch.zigbee2mqtt_bridge_permit_join", "on");
  const data = ok(await call("start_pairing", { seconds: 60 }), "start_pairing");
  assert.equal(
    data.mesh_open, true,
    "the permit-join switch is the only readable proof; `published: true` proves only that HA accepted it",
  );
});

test("start_pairing REFUSES to report success when the mesh did not actually open", async () => {
  // Zigbee2MQTT ignoring the request looks EXACTLY like it accepting one: the
  // publish returns 200 either way and nothing answers on bridge/response.
  ha.setState("switch.zigbee2mqtt_bridge_permit_join", "off");
  const res = await call("start_pairing", { seconds: 60 });

  assert.equal(
    res.result.isError, true,
    "a mesh that did not open is a failure, not a footnote on a success",
  );
  const text = res.result.content?.[0]?.text ?? "";
  assert.match(text, /did not open/i, "it must say plainly that the mesh is shut");
  assert.match(text, /reset/i, "and stop the model sending someone to reset a device for nothing");
});

// ------------------------------------------------------------------- poll_pairing

test("poll_pairing with no baseline refuses to call anything new", async () => {
  const data = ok(await call("poll_pairing"), "poll_pairing");
  assert.equal(data.baseline, null);
  assert.deepEqual(data.appeared, [], "with no baseline, nothing can be new");
  assert.match(data.verdict, /start_pairing first/, "it must route the model to establish a baseline");
  assert.equal(
    data.bridge_events, null,
    "null means 'not listening to the broker', which is different from an empty array",
  );
});

test("poll_pairing reports a device that appeared in the registry since pairing opened", async () => {
  ha.setState("switch.zigbee2mqtt_bridge_permit_join", "on");
  ok(await call("start_pairing", { seconds: 120 }), "start_pairing");

  // A bulb finishes its interview: Home Assistant registers the device.
  ha.setDevices([...deviceFixture(), newlyJoinedDevice()]);
  ha.setEntities([...entityFixture(), newlyJoinedEntity()]);

  const data = ok(await call("poll_pairing"), "poll_pairing");
  assert.equal(data.appeared_count, 1);
  assert.equal(data.appeared[0].ieee_address, "0x00124b0022aabbcc");
  assert.equal(data.appeared[0].primary_entity, "light.0x00124b0022aabbcc");
  assert.match(data.verdict, /0x00124b0022aabbcc/, "the verdict must NAME what arrived");
  assert.match(data.verdict, /name_device/, "and route to the next step");
  assert.ok(data.baseline.at, "the baseline is what makes 'new' meaningful");
});

test("poll_pairing reports nothing new when nothing joined, without inventing a failure", async () => {
  ha.setState("switch.zigbee2mqtt_bridge_permit_join", "on");
  ok(await call("start_pairing", { seconds: 120 }), "start_pairing");
  const data = ok(await call("poll_pairing"), "poll_pairing");
  assert.equal(data.appeared_count, 0);
  assert.match(data.verdict, /Nothing new/i);
  assert.match(data.verdict, /poll again/i, "pairing is slow; the model must be told to wait rather than give up");
});

// -------------------------------------------------------------------- name_device

test("name_device renames in BOTH systems and says so only when both landed", async () => {
  const data = ok(
    await call("name_device", { ieee_address: "0x00124b0022ffeedd", friendly_name: "Floor lamp" }),
    "name_device",
  );

  // Half one, through Home Assistant's broker connection.
  const publish = ha.published.find((p) => p.topic === "zigbee2mqtt/bridge/request/device/rename");
  assert.ok(publish, "the z2m half must go out as an mqtt.publish, not a direct broker publish");
  const payload = JSON.parse(publish.payload);
  assert.equal(payload.from, "0x00124b0022ffeedd", "z2m is addressed by the name z2m itself uses");
  assert.equal(payload.to, "Floor lamp");

  // Half two, over the WebSocket entity registry.
  assert.deepEqual(ha.renames, [{ entity_id: "light.0x00124b0022ffeedd", name: "Floor lamp" }]);

  assert.equal(data.fully_renamed, true);
  assert.equal(data.home_assistant.renamed, true);
  assert.equal(data.zigbee2mqtt.renamed, true);
  assert.match(data.summary, /both/i);
  assert.match(
    data.summary, /acknowledgement could not be read/i,
    "a publish nobody confirmed must be described as unconfirmed, not as verified",
  );
});

test("name_device reports fully_renamed:false when only the Zigbee2MQTT half lands", async () => {
  ha.failEntityUpdate("Unauthorized: user is not an admin");

  const data = ok(
    await call("name_device", { ieee_address: "0x00124b0022ffeedd", friendly_name: "Floor lamp" }),
    "name_device",
  );

  assert.equal(data.zigbee2mqtt.renamed, true);
  assert.equal(data.home_assistant.renamed, false);
  assert.equal(data.fully_renamed, false, "half a rename must never be reported as a rename");
  assert.match(data.summary, /Zigbee2MQTT ONLY/);
  assert.match(data.summary, /disagree/, "the model must be told the two systems now disagree");
  assert.match(data.home_assistant.error, /not an admin/, "the real reason must survive to the model");
});

test("name_device still runs the Home Assistant half when the Zigbee2MQTT half fails", async () => {
  // The publish is what fails now. The old code threw here and never attempted
  // the entity rename at all — which guaranteed the two systems disagreed and
  // said nothing about it.
  ha.failPublish([500, { message: "mqtt integration not loaded" }]);

  const data = ok(
    await call("name_device", { ieee_address: "0x00124b0022ffeedd", friendly_name: "Floor lamp" }),
    "name_device",
  );

  assert.equal(data.zigbee2mqtt.renamed, false);
  assert.equal(data.home_assistant.renamed, true, "the second half must still have been attempted");
  assert.deepEqual(ha.renames, [{ entity_id: "light.0x00124b0022ffeedd", name: "Floor lamp" }]);
  assert.equal(data.fully_renamed, false);
  assert.match(data.summary, /Home Assistant ONLY/);
  assert.match(data.summary, /0x00124b0022ffeedd/, "it must say what the mesh still calls the device");
});

test("name_device reports nothing renamed when neither half lands", async () => {
  ha.failPublish([500, { message: "mqtt integration not loaded" }]);
  ha.failEntityUpdate("Unauthorized: user is not an admin");

  const data = ok(
    await call("name_device", { ieee_address: "0x00124b0022ffeedd", friendly_name: "Floor lamp" }),
    "name_device",
  );
  assert.equal(data.fully_renamed, false);
  assert.match(data.summary, /NOTHING was renamed/);
});

test("name_device accepts the current name as well as the address, and names what exists when it cannot match", async () => {
  const byName = ok(
    await call("name_device", { ieee_address: "Shelf lamp", friendly_name: "Reading lamp" }),
    "name_device by current name",
  );
  assert.equal(byName.ieee_address, "0x00124b0022a1b2c3");

  const missing = await call("name_device", { ieee_address: "0xdeadbeefdeadbeef", friendly_name: "Nope" });
  assert.equal(missing.error, undefined, "bad input is a result the model reads, not a protocol error");
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /No Zigbee device matches/);
  assert.match(
    missing.result.content[0].text, /0x00124b0022a1b2c3/,
    "the refusal must list the real options so the model can retry",
  );
});

test("an explicit entity_id overrides the device's primary entity", async () => {
  ok(
    await call("name_device", {
      ieee_address: "0x00124b0022a1b2c3",
      friendly_name: "Reading lamp",
      entity_id: "sensor.shelf_lamp_linkquality",
    }),
    "name_device with an explicit entity",
  );
  assert.deepEqual(ha.renames, [{ entity_id: "sensor.shelf_lamp_linkquality", name: "Reading lamp" }]);
});

// ------------------------------------------------------- the whole surface, dry

test("no Zigbee tool depends on MQTT_URL being set", async () => {
  assert.equal(process.env.MQTT_URL, undefined, "this file's premise is that the broker is absent");
  for (const [name, args] of [
    ["list_zigbee_devices", {}],
    ["start_pairing", { seconds: 30 }],
    ["poll_pairing", {}],
    ["name_device", { ieee_address: "0x00124b0022ffeedd", friendly_name: "Floor lamp" }],
  ]) {
    const res = await call(name, args);
    assert.equal(res.error, undefined, `${name} must never be a protocol error`);
    assert.equal(
      res.result.isError, false,
      `${name} failed with the broker absent: ${res.result.content?.[0]?.text ?? ""}`,
    );
    assert.equal(
      /MQTT_URL/.test(JSON.stringify(res.result)), false,
      `${name} still tells the model to configure MQTT_URL, which is not obtainable`,
    );
  }
});

test("without Home Assistant the Zigbee tools say what is actually missing", async () => {
  const base = process.env.HA_BASE_URL;
  delete process.env.HA_BASE_URL;
  try {
    const res = await call("list_zigbee_devices");
    assert.equal(res.error, undefined, "a missing configuration is a result, not a protocol error");
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /HA_BASE_URL/);
    assert.match(
      res.result.content[0].text, /get_room/,
      "it must point at what still works instead of implying the house is broken",
    );
  } finally {
    process.env.HA_BASE_URL = base;
  }
});
