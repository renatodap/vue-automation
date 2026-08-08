import Testing
@testable import VueCore

/// The colour maths is the one piece of pure logic worth testing: the room map
/// is only legible if a warm lamp looks warm, and a sign error here would be
/// invisible in code review and obvious on the wall.
@Suite struct LightColorTests {
    @Test func warmIsRedderThanCool() {
        let warm = LightColor.rgb(kelvin: 2200)
        let cool = LightColor.rgb(kelvin: 6500)
        #expect(warm.red >= cool.red)
        #expect(warm.blue < cool.blue)
    }

    @Test func staysInGamut() {
        for k in stride(from: 1000, through: 10_000, by: 250) {
            let c = LightColor.rgb(kelvin: k)
            #expect((0...1).contains(c.red))
            #expect((0...1).contains(c.green))
            #expect((0...1).contains(c.blue))
        }
    }

    @Test func lowKelvinHasNoBlue() {
        #expect(LightColor.rgb(kelvin: 1500).blue == 0)
    }

    /// A bulb in a colour mode reports a stale colour_temp_kelvin from whenever
    /// it last did white. Reading kelvin first would paint a green lamp amber.
    @Test func colourModeBeatsStaleKelvin() {
        let green = Lamp(
            entityId: "light.x", name: "X", reachable: true, on: true,
            brightness: 50, kelvin: 2700, minKelvin: 2000, maxKelvin: 6500,
            rgb: [0, 255, 0], hs: [120, 100], supportsColor: true, colorMode: "xy")
        let c = LightColor.rgb(for: green)
        #expect(c.green > c.red)
        #expect(c.green > c.blue)
    }

    @Test func hueWrapsAndClamps() {
        let a = LightColor.rgb(hue: 400, saturation: 150)
        let b = LightColor.rgb(hue: 40, saturation: 100)
        #expect(abs(a.red - b.red) < 0.001)
        #expect(abs(a.green - b.green) < 0.001)
    }
}
