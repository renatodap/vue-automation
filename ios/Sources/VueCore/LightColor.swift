import Foundation

/// What a lamp actually looks like, as RGB in 0–1.
///
/// This is load-bearing rather than decorative: the room map draws each lamp in
/// its own colour, so this function is the difference between the screen showing
/// the room and the screen showing four identical dots.
public struct LightRGB: Sendable, Hashable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(red: Double, green: Double, blue: Double) {
        self.red = red.clampedToUnit
        self.green = green.clampedToUnit
        self.blue = blue.clampedToUnit
    }

    public static let warmWhite = LightRGB(red: 1.0, green: 0.66, blue: 0.35)
}

private extension Double {
    var clampedToUnit: Double { Swift.min(1, Swift.max(0, self)) }
}

public enum LightColor {
    /// Colour temperature to RGB.
    ///
    /// Tanner Helland's piecewise fit to the Planckian locus. An approximation,
    /// and the right kind: it is smooth, it is monotonic, and it is visually
    /// correct across 1000–40000 K, which matters more here than colorimetric
    /// exactness — nobody is matching a swatch, they are recognising "that lamp
    /// is the warm one".
    public static func rgb(kelvin: Int) -> LightRGB {
        let t = Double(min(40_000, max(1_000, kelvin))) / 100

        let r: Double
        let g: Double
        let b: Double

        if t <= 66 {
            r = 255
            g = 99.4708025861 * log(t) - 161.1195681661
            // Below 19 hundred-kelvin the blue channel is genuinely zero; the
            // log would go to -inf.
            b = t <= 19 ? 0 : 138.5177312231 * log(t - 10) - 305.0447927307
        } else {
            r = 329.698727446 * pow(t - 60, -0.1332047592)
            g = 288.1221695283 * pow(t - 60, -0.0755148492)
            b = 255
        }

        return LightRGB(red: r / 255, green: g / 255, blue: b / 255)
    }

    /// Hue/saturation as Home Assistant reports it — hue 0–360, saturation
    /// 0–100 — at full value, because brightness is carried separately.
    public static func rgb(hue: Double, saturation: Double) -> LightRGB {
        let h = (hue.truncatingRemainder(dividingBy: 360) + 360)
            .truncatingRemainder(dividingBy: 360) / 60
        let s = min(1, max(0, saturation / 100))
        let c = s
        let x = c * (1 - abs(h.truncatingRemainder(dividingBy: 2) - 1))
        let m = 1 - c

        let (r, g, b): (Double, Double, Double) = switch Int(h) {
        case 0: (c, x, 0)
        case 1: (x, c, 0)
        case 2: (0, c, x)
        case 3: (0, x, c)
        case 4: (x, 0, c)
        default: (c, 0, x)
        }
        return LightRGB(red: r + m, green: g + m, blue: b + m)
    }

    /// The colour to paint a lamp with, given everything known about it.
    ///
    /// Precedence matters and is not arbitrary. A bulb in `xy`/`hs` mode is
    /// showing a colour, and its `color_temp_kelvin` is stale from whenever it
    /// last did white — reading kelvin first would paint a green lamp amber.
    public static func rgb(for lamp: Lamp) -> LightRGB {
        if let rgb = lamp.rgb, rgb.count == 3, lamp.colorMode != "color_temp" {
            return LightRGB(
                red: Double(rgb[0]) / 255,
                green: Double(rgb[1]) / 255,
                blue: Double(rgb[2]) / 255)
        }
        if let hs = lamp.hs, hs.count == 2, lamp.colorMode != "color_temp" {
            return rgb(hue: hs[0], saturation: hs[1])
        }
        if let k = lamp.kelvin { return rgb(kelvin: k) }
        return .warmWhite
    }
}
