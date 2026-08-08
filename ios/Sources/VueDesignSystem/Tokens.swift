import SwiftUI

/// Ported one-for-one from `web/src/app/globals.css`.
///
/// Dark is the default and that is a decision, not a fashion: this app's whole
/// job is dimming lights in a dark room, and a cream screen at 9pm undoes the
/// thing the user just asked for. The greys carry a yellow bias rather than the
/// usual blue one, so the UI reads as lamplight instead of as a terminal.
public enum Palette {
    public static let background = Color(hex: 0x14120E)
    public static let surface = Color(hex: 0x1D1A15)
    public static let surfaceSunken = Color(hex: 0x100E0B)
    public static let elevated = Color(hex: 0x26221B)

    public static let inkPrimary = Color(hex: 0xF5F1E8)
    public static let inkSecondary = Color(hex: 0xB6AE9E)
    public static let inkMuted = Color(hex: 0x8B8375)
    public static let onAccent = Color(hex: 0x1A1508)

    public static let border = Color(hex: 0x2C2721)
    public static let borderStrong = Color(hex: 0x3D372D)

    /// Lamp-glow amber — also roughly the colour a 2700 K bulb actually throws.
    public static let accent = Color(hex: 0xE8A54D)
    public static let accentSubtle = Color(hex: 0xE8A54D, opacity: 0.14)
    public static let accentBorder = Color(hex: 0xE8A54D, opacity: 0.32)

    public static let positive = Color(hex: 0x6BBF8A)
    public static let negative = Color(hex: 0xE8746A)
    public static let warning = Color(hex: 0xE0A34A)
    public static let warningSurface = Color(hex: 0xE0A34A, opacity: 0.14)
    public static let neutralSurface = Color(hex: 0x262119)
}

public enum Metrics {
    public static let space1: CGFloat = 4
    public static let space2: CGFloat = 8
    public static let space3: CGFloat = 12
    public static let space4: CGFloat = 16
    public static let space5: CGFloat = 20
    public static let space6: CGFloat = 24
    public static let space8: CGFloat = 32

    public static let radiusSM: CGFloat = 6
    public static let radiusMD: CGFloat = 10
    public static let radiusLG: CGFloat = 16
    public static let radiusXL: CGFloat = 22

    /// Apple's minimum comfortable hit target. Non-negotiable on a screen whose
    /// controls are dragged in the dark.
    public static let minimumTapTarget: CGFloat = 44

    public static let pagePadding: CGFloat = 16
}

public enum Motion {
    /// No overshoot. Most UI here carries no momentum, and bounce on something
    /// that merely faded in feels wrong.
    public static let standard = Animation.spring(response: 0.35, dampingFraction: 1.0)
    /// Sheets and trays, which are dragged and so have earned a little bounce.
    public static let sheet = Animation.spring(response: 0.3, dampingFraction: 0.8)
    /// The reduced-motion substitute — a gentle cross-fade, not nothing.
    public static let reduced = Animation.easeOut(duration: 0.18)

    public static func adaptive(_ base: Animation, reduceMotion: Bool) -> Animation {
        reduceMotion ? reduced : base
    }
}

public extension Color {
    /// `Color(hex: 0xE8A54D)`. Kept here rather than at each call site so the
    /// palette above reads as the CSS it was ported from.
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity)
    }
}
