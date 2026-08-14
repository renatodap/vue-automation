import Testing
@testable import VueCore

/// A lamp that has lost power is the most common non-normal state in this room,
/// and the app used to render it as a dimmed row with no explanation — which
/// reads as the app being broken rather than as the bulb being switched off at
/// the wall. These pin the wording so a refactor cannot quietly go back to grey.
@Suite struct LampStatusTests {
    private func lamp(
        reachable: Bool = true, on: Bool = true,
        brightness: Int? = 60, kelvin: Int? = 2700, hs: [Double]? = nil
    ) -> Lamp {
        Lamp(
            entityId: "light.x", name: "Shelf Lamp", reachable: reachable, on: on,
            brightness: brightness, kelvin: kelvin, minKelvin: 2000, maxKelvin: 6493,
            rgb: nil, hs: hs, supportsColor: true,
            colorMode: hs != nil ? "hs" : "color_temp")
    }

    @Test func reachableLampHasNoTrouble() {
        #expect(lamp().trouble == nil)
    }

    /// Names the lamp and says where to go and do something about it. "Offline"
    /// would be true and useless.
    @Test func unreachableLampNamesItselfAndTheCause() {
        let trouble = lamp(reachable: false).trouble
        #expect(trouble?.contains("Shelf Lamp") == true)
        #expect(trouble?.contains("switched off") == true)
    }

    @Test func statusLineLeadsWithPowerWhenUnreachable() {
        // Crucially NOT "Off": the bulb may well be set to full brightness, and
        // reporting it as off is a stale reading dressed up as a current one.
        #expect(lamp(reachable: false, on: true).statusLine.contains("No power"))
    }

    @Test func statusLineReportsBrightnessAndWarmth() {
        #expect(lamp(brightness: 42, kelvin: 3000).statusLine == "42% · 3000K")
    }

    /// A bulb in a colour mode carries a stale `color_temp_kelvin` from whenever
    /// it last did white, so the line must key off the colour, not the leftover.
    @Test func statusLineSaysColourWhenInColourMode() {
        #expect(lamp(kelvin: nil, hs: [120, 100]).statusLine == "60% · colour")
    }

    @Test func offBeatsEverythingButPower() {
        #expect(lamp(on: false).statusLine == "Off")
    }
}
