import SwiftUI
import VueCore

public extension Color {
    /// A lamp's real colour, for the marker on the room map.
    init(_ rgb: LightRGB) {
        self.init(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue, opacity: 1)
    }

    /// What this lamp is actually throwing right now.
    init(lamp: Lamp) {
        self.init(LightColor.rgb(for: lamp))
    }
}

/// The warm→cool gradient used on every colour-temperature control.
///
/// The track carries the gradient it selects, so the control reads as warm→cool
/// before you look at the number.
public enum Gradients {
    public static let temperature = LinearGradient(
        colors: [
            Color(hex: 0xFF9329), Color(hex: 0xFFB765), Color(hex: 0xFFD6AA),
            Color(hex: 0xFFF4E8), Color(hex: 0xF2F4FF), Color(hex: 0xCFDCFF),
        ],
        startPoint: .leading, endPoint: .trailing)
}
