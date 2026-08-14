import Foundation

/// One bulb, as the server projects it.
///
/// Mirrors `web/src/lib/types.ts:LampView` field for field. The two are a
/// contract; when one changes the other has to, and keeping the names identical
/// is what makes a mismatch obvious in review rather than at runtime.
public struct Lamp: Codable, Sendable, Hashable, Identifiable {
    public let entityId: String
    public let name: String
    /// False when the bulb has lost power — someone switched it off at the lamp.
    public let reachable: Bool
    public let on: Bool
    /// 0–100. Null when off, or when the bulb has not reported one.
    public let brightness: Int?
    /// Null when the bulb is in a colour mode rather than white balance.
    public let kelvin: Int?
    /// The bulb's own tunable range. Never hardcode 2700–6500: these report
    /// 2000–6493 and a value outside the real range is rejected silently, which
    /// looks exactly like the tap not registering.
    public let minKelvin: Int
    public let maxKelvin: Int
    public let rgb: [Int]?
    /// `[hue 0–360, saturation 0–100]` when the bulb is in a colour mode.
    public let hs: [Double]?
    public let supportsColor: Bool
    public let colorMode: String?

    public var id: String { entityId }

    public init(
        entityId: String, name: String, reachable: Bool, on: Bool,
        brightness: Int?, kelvin: Int?, minKelvin: Int, maxKelvin: Int,
        rgb: [Int]?, hs: [Double]?, supportsColor: Bool, colorMode: String?
    ) {
        self.entityId = entityId
        self.name = name
        self.reachable = reachable
        self.on = on
        self.brightness = brightness
        self.kelvin = kelvin
        self.minKelvin = minKelvin
        self.maxKelvin = maxKelvin
        self.rgb = rgb
        self.hs = hs
        self.supportsColor = supportsColor
        self.colorMode = colorMode
    }
}

extension Lamp {
    /// Why this lamp is not answering, in words rather than in grey.
    ///
    /// A Zigbee bulb that has been switched off at the lamp or at the wall is
    /// simply gone from the mesh — there is no "off" state to report, because
    /// nothing is listening. It is by far the most common non-normal state in
    /// this room, and rendering it as a dimmed row with no explanation makes it
    /// look like the app failed rather than like the lamp is unplugged.
    public var trouble: String? {
        reachable ? nil : "No power at \(name) — it's switched off at the lamp or the wall"
    }

    /// The short version, for a row subtitle.
    public var statusLine: String {
        guard reachable else { return "No power — switched off at the lamp" }
        guard on else { return "Off" }
        let colour = kelvin.map { "\($0)K" } ?? (hs != nil ? "colour" : "—")
        return "\(brightness ?? 100)% · \(colour)"
    }
}

public struct LightScene: Codable, Sendable, Hashable, Identifiable {
    public let entityId: String
    public let name: String
    /// The Home Assistant config id (`vue_movie`), as opposed to the entity id
    /// (`scene.movie`). Editing and deleting go through this one; activating
    /// goes through the entity. Null for a scene HA loaded from somewhere this
    /// app did not write.
    public let id: String?
    public let label: String
    public let accent: String?
    public let sortOrder: Int?
    public let tapCount: Int
    public let lastActivated: String?
    public let lastTappedAt: String?

    public init(
        entityId: String, name: String, id: String?, label: String,
        accent: String?, sortOrder: Int?, tapCount: Int,
        lastActivated: String?, lastTappedAt: String?
    ) {
        self.entityId = entityId
        self.name = name
        self.id = id
        self.label = label
        self.accent = accent
        self.sortOrder = sortOrder
        self.tapCount = tapCount
        self.lastActivated = lastActivated
        self.lastTappedAt = lastTappedAt
    }
}

extension LightScene {
    /// `Identifiable` keys off the entity id, which is what the UI diffs on.
    public var identity: String { entityId }
}

public struct Automation: Codable, Sendable, Hashable, Identifiable {
    public let entityId: String
    public let name: String
    public let id: String?
    public let enabled: Bool

    public init(entityId: String, name: String, id: String?, enabled: Bool) {
        self.entityId = entityId
        self.name = name
        self.id = id
        self.enabled = enabled
    }
}

/// Everything one `/api/state` round trip returns.
public struct HouseState: Codable, Sendable, Hashable {
    public let scenes: [LightScene]
    public let lamps: [Lamp]
    public let automations: [Automation]
    public let unreachableCount: Int

    public init(scenes: [LightScene], lamps: [Lamp], automations: [Automation], unreachableCount: Int) {
        self.scenes = scenes
        self.lamps = lamps
        self.automations = automations
        self.unreachableCount = unreachableCount
    }

    public static let empty = HouseState(
        scenes: [], lamps: [], automations: [], unreachableCount: 0)
}

extension HouseState {
    public var reachable: [Lamp] { lamps.filter(\.reachable) }
    public var lit: [Lamp] { reachable.filter(\.on) }
    public var anyOn: Bool { !lit.isEmpty }

    /// Where the room actually is, averaged over what is LIT.
    ///
    /// Averaging over every lamp would drag the number toward zero each time one
    /// is off, and the master control would then lie about the room.
    public var averageBrightness: Int {
        guard !lit.isEmpty else { return 60 }
        return Int((lit.map { Double($0.brightness ?? 100) }.reduce(0, +) / Double(lit.count)).rounded())
    }

    public var averageKelvin: Int {
        let withK = lit.compactMap(\.kelvin)
        guard !withK.isEmpty else { return 2700 }
        return Int((Double(withK.reduce(0, +)) / Double(withK.count)).rounded())
    }

    /// The tightest range every lamp can actually honour.
    public var kelvinRange: ClosedRange<Int> {
        let lo = lamps.map(\.minKelvin).max() ?? 2000
        let hi = lamps.map(\.maxKelvin).min() ?? 6500
        return lo < hi ? lo...hi : 2000...6500
    }

    /// The one-line summary under the title.
    public var summary: String {
        guard !lamps.isEmpty else { return "No lamps paired yet" }
        let on = lamps.filter(\.on).count
        var parts = [on == 0 ? "All off" : "\(on) of \(lamps.count) on"]
        let out = lamps.filter { !$0.reachable }.count
        if out > 0 { parts.append("\(out) unreachable") }
        return parts.joined(separator: " · ")
    }
}
