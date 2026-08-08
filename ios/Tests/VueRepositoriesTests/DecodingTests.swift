import Foundation
import Testing
import VueCore
@testable import VueRepositories

/// Decoding is a contract with `web/src/lib/types.ts`. These fixtures are copied
/// from a real /api/state response so a server-side rename fails here rather
/// than as an empty screen on a phone.
@Suite struct DecodingTests {
    @Test func decodesARealLamp() throws {
        let json = """
        {"entityId":"light.floor_lamp","name":"Floor Lamp","reachable":true,"on":true,
         "brightness":45,"kelvin":2702,"minKelvin":2000,"maxKelvin":6493,
         "rgb":[255,167,88],"hs":[28.391,65.659],"supportsColor":true,
         "colorMode":"color_temp"}
        """.data(using: .utf8)!
        let lamp = try JSONDecoder().decode(Lamp.self, from: json)
        #expect(lamp.entityId == "light.floor_lamp")
        #expect(lamp.brightness == 45)
        #expect(lamp.maxKelvin == 6493)
    }

    /// An off lamp reports null brightness. Coalescing that to 0 would make the
    /// master slider read as "the room is at 0%" rather than "nothing is lit".
    @Test func toleratesNulls() throws {
        let json = """
        {"entityId":"light.a","name":"A","reachable":false,"on":false,
         "brightness":null,"kelvin":null,"minKelvin":2000,"maxKelvin":6500,
         "rgb":null,"hs":null,"supportsColor":false,"colorMode":null}
        """.data(using: .utf8)!
        let lamp = try JSONDecoder().decode(Lamp.self, from: json)
        #expect(lamp.brightness == nil)
        #expect(lamp.supportsColor == false)
    }

    @Test func averagesOverLitLampsOnly() {
        func lamp(_ id: String, on: Bool, bri: Int?) -> Lamp {
            Lamp(entityId: id, name: id, reachable: true, on: on, brightness: bri,
                 kelvin: 2700, minKelvin: 2000, maxKelvin: 6500, rgb: nil, hs: nil,
                 supportsColor: true, colorMode: "color_temp")
        }
        let state = HouseState(
            scenes: [], lamps: [lamp("a", on: true, bri: 80), lamp("b", on: false, bri: nil)],
            automations: [], unreachableCount: 0)
        // 80, not 40 — the off lamp must not drag the number toward zero.
        #expect(state.averageBrightness == 80)
    }
}
