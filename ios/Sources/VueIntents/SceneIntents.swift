import AppIntents
import Foundation
import VueCore
import VueRepositories

#if canImport(WidgetKit)
import WidgetKit
#endif

// MARK: - The entity

/// A scene, as Siri and Shortcuts see it.
///
/// The `alternativeNames` on the display representation are the whole point of
/// this type. Siri cannot take a free-form phrase parameter — "turn on
/// «anything»" is not expressible — but it CAN expand a phrase template over a
/// finite list of entity values, matching each against its title and its
/// synonyms. So the aliases the user types in the app become real spoken
/// phrases, with no code and no rebuild.
public struct SceneEntity: AppEntity, Identifiable, Sendable {
    public let id: String
    public let label: String
    public let aliases: [String]
    public let symbol: String

    public init(id: String, label: String, aliases: [String], symbol: String) {
        self.id = id
        self.label = label
        self.aliases = aliases
        self.symbol = symbol
    }

    public init(_ entry: SceneCatalogueEntry) {
        self.init(id: entry.entityId, label: entry.label,
                  aliases: entry.aliases, symbol: entry.symbol)
    }

    public static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "LightScene")
    }

    public var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(label)",
            subtitle: "Lighting scene",
            image: .init(systemName: symbol),
            // Straight out of the catalogue, which is straight out of a text
            // field. Changing them requires updateAppShortcutParameters().
            synonyms: aliases.map { LocalizedStringResource(stringLiteral: $0) })
    }

    public static let defaultQuery = SceneEntityQuery()

    /// What a Control Center control shows before anybody has configured it.
    ///
    /// It has an empty id on purpose, and `ActivateSceneIntent` refuses to run
    /// against one. A control that silently does nothing is worse than a control
    /// that says what it needs.
    public static let unconfigured = SceneEntity(
        id: "", label: "Pick a scene", aliases: [], symbol: "lightbulb")

    public var isConfigured: Bool { !id.isEmpty }
}

/// Resolves scenes for Siri, Spotlight and Shortcuts.
///
/// Reads the on-disk mirror and nothing else — see `SceneCatalogue` for why a
/// network call here is a bug rather than an optimisation.
public struct SceneEntityQuery: EntityQuery, EntityStringQuery, Sendable {
    public init() {}

    public func entities(for identifiers: [String]) async throws -> [SceneEntity] {
        let all = SceneCatalogueStore.load().scenes
        // Preserve the order asked for; a caller handing us ids expects them back
        // in the same sequence.
        return identifiers.compactMap { id in
            all.first { $0.entityId == id }.map(SceneEntity.init)
        }
    }

    /// Everything, so App Shortcut phrases can be generated per scene.
    ///
    /// This is what makes "Hey Siri, Vue Lights Movie" exist at all.
    public func suggestedEntities() async throws -> [SceneEntity] {
        SceneCatalogueStore.load().scenes.map(SceneEntity.init)
    }

    /// Siri heard a word; find the scene it meant.
    ///
    /// Matches aliases as well as the label, so "netflix" finds Movie even
    /// though no scene is called that.
    public func entities(matching string: String) async throws -> [SceneEntity] {
        let needle = string.folding(options: .diacriticInsensitive, locale: .current).lowercased()
        return SceneCatalogueStore.load().scenes
            .filter { entry in
                let haystack = [entry.label] + entry.aliases
                return haystack.contains {
                    $0.folding(options: .diacriticInsensitive, locale: .current)
                        .lowercased().contains(needle)
                }
            }
            .map(SceneEntity.init)
    }
}

// MARK: - Shared plumbing

public enum IntentRuntime {
    /// The client an intent uses. Built per call rather than held: an intent can
    /// run in a process that lives for one second, and a cached actor buys
    /// nothing there.
    ///
    /// The settings come from the **shared** defaults suite, not from
    /// `UserDefaults.standard`. An intent fired from a widget button or a
    /// Control Center control runs inside the widget extension, which has its
    /// own `standard` suite — reading from there would find no custom server URL
    /// and no token, and the failure would look like the server being down.
    public static func client(timeout: TimeInterval = 12) -> APIClient {
        let url = VueSettings.baseURL.flatMap(URL.init(string:)) ?? VueAPI.defaultBaseURL
        return APIClient(baseURL: url, token: VueSettings.token, timeout: timeout)
    }

    /// The room just changed and we did not read what it changed to.
    ///
    /// Drops the cached reading rather than leaving the old one in place. The
    /// widget then prints no status line at all until the app next refreshes,
    /// which is the honest answer — invariant #3 is about never showing a stale
    /// reading as current, and "we just fired a scene" is precisely when the
    /// cached one is guaranteed wrong.
    static func invalidateRoomCache() {
        if let last = RoomSnapshotStore.load() {
            RoomSnapshotStore.save(RoomSnapshot(
                lampsOn: last.lampsOn, lampsTotal: last.lampsTotal,
                unreachable: last.unreachable, averageBrightness: last.averageBrightness,
                capturedAt: .distantPast))
        }
        reloadSurfaces()
    }

    /// Redraw the widget and the controls.
    public static func reloadSurfaces() {
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadAllTimelines()
        ControlCenter.shared.reloadAllControls()
        #endif
    }
}

// MARK: - Intents

public struct ActivateSceneIntent: AppIntent {
    public static let title: LocalizedStringResource = "Set a scene"
    public static let description = IntentDescription(
        "Applies one of your lighting scenes to the living room.",
        categoryName: "Scenes")

    /// Opening the app would defeat the point — the fastest interaction with
    /// this app is the one where it never appears.
    public static let openAppWhenRun: Bool = false

    @Parameter(title: "LightScene")
    public var scene: SceneEntity

    public init() {}
    public init(scene: SceneEntity) { self.scene = scene }

    public static var parameterSummary: some ParameterSummary {
        Summary("Set \(\.$scene)")
    }

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        // A Control Center control that has never been configured, or a widget
        // button for a scene that has since been deleted. Both are reachable by
        // a real tap, and both must say so rather than appear to work.
        guard scene.isConfigured else {
            return .result(dialog: "Choose a scene for that button first.")
        }

        let result: SceneResult
        do {
            result = try await IntentRuntime.client().activate(scene: scene.id)
        } catch let error as VueError {
            // A spoken failure, not a thrown one. Siri renders a thrown error as
            // a generic "something went wrong", which tells the user nothing
            // about whether the lights changed.
            return .result(dialog: IntentDialog(stringLiteral: error.errorDescription ?? "That didn't work."))
        }

        // The room is now something we have not read. Drop the cached reading
        // rather than let a widget keep printing the old one.
        IntentRuntime.invalidateRoomCache()

        // Report partial application. Home Assistant applies a scene to what it
        // can reach and says nothing about the rest, and silence reads as
        // success — which is how you end up asking twice for a lamp that is
        // switched off at the wall.
        if result.unreachable.isEmpty {
            return .result(dialog: IntentDialog(stringLiteral: scene.label))
        }
        let names = result.unreachable.joined(separator: ", ")
        return .result(dialog: IntentDialog(stringLiteral:
            "\(scene.label). I couldn't reach \(names)."))
    }
}

public struct AllLightsOffIntent: AppIntent {
    public static let title: LocalizedStringResource = "Turn all lights off"
    public static let description = IntentDescription(
        "Switches off every reachable lamp in the living room.", categoryName: "Lights")
    public static let openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let client = IntentRuntime.client()
        do {
            let state = try await client.state()
            let targets = state.lit.map(\.entityId)
            guard !targets.isEmpty else { return .result(dialog: "They're already off.") }
            try await client.setLights(targets, on: false)
            RoomSnapshotStore.save(RoomSnapshot(
                lampsOn: 0, lampsTotal: state.lamps.count,
                unreachable: state.lamps.count - state.reachable.count,
                averageBrightness: 0))
            IntentRuntime.reloadSurfaces()
            return .result(dialog: "Lights off.")
        } catch let error as VueError {
            return .result(dialog: IntentDialog(stringLiteral: error.errorDescription ?? "That didn't work."))
        }
    }
}

public struct AllLightsOnIntent: AppIntent {
    public static let title: LocalizedStringResource = "Turn all lights on"
    public static let description = IntentDescription(
        "Switches on every reachable lamp in the living room.", categoryName: "Lights")
    public static let openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let client = IntentRuntime.client()
        do {
            let state = try await client.state()
            let targets = state.reachable.map(\.entityId)
            guard !targets.isEmpty else { return .result(dialog: "I can't reach any lamps.") }
            // Hold the room's current level rather than blasting to 100%.
            try await client.setLights(targets, on: true, brightness: state.averageBrightness)
            RoomSnapshotStore.save(RoomSnapshot(
                lampsOn: targets.count, lampsTotal: state.lamps.count,
                unreachable: state.lamps.count - targets.count,
                averageBrightness: state.averageBrightness))
            IntentRuntime.reloadSurfaces()
            return .result(dialog: "Lights on.")
        } catch let error as VueError {
            return .result(dialog: IntentDialog(stringLiteral: error.errorDescription ?? "That didn't work."))
        }
    }
}

/// A fixed set of levels, so the phrase can carry the value.
///
/// An `AppEnum` rather than an Int parameter on purpose: Siri expands phrases
/// over enum cases, so "set the lights to half" is a real phrase. A free numeric
/// parameter would force a follow-up question every time.
public enum BrightnessLevel: String, AppEnum, Sendable {
    case lowest, low, half, high, full

    public static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "Brightness")
    }

    public static let caseDisplayRepresentations: [BrightnessLevel: DisplayRepresentation] = [
        .lowest: DisplayRepresentation(title: "10%", synonyms: ["lowest", "dimmest", "as low as possible"]),
        .low: DisplayRepresentation(title: "25%", synonyms: ["low", "dim"]),
        .half: DisplayRepresentation(title: "50%", synonyms: ["half", "medium"]),
        .high: DisplayRepresentation(title: "75%", synonyms: ["high", "bright"]),
        .full: DisplayRepresentation(title: "100%", synonyms: ["full", "brightest", "maximum"]),
    ]

    var percent: Int {
        switch self {
        case .lowest: 10
        case .low: 25
        case .half: 50
        case .high: 75
        case .full: 100
        }
    }
}

public struct SetBrightnessIntent: AppIntent {
    public static let title: LocalizedStringResource = "Set brightness"
    public static let description = IntentDescription(
        "Sets every reachable lamp to a brightness.", categoryName: "Lights")
    public static let openAppWhenRun: Bool = false

    @Parameter(title: "Level")
    public var level: BrightnessLevel

    public init() {}

    public static var parameterSummary: some ParameterSummary {
        Summary("Set the lights to \(\.$level)")
    }

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let client = IntentRuntime.client()
        do {
            let state = try await client.state()
            let targets = state.reachable.map(\.entityId)
            guard !targets.isEmpty else { return .result(dialog: "I can't reach any lamps.") }
            try await client.setLights(targets, on: true, brightness: level.percent)
            RoomSnapshotStore.save(RoomSnapshot(
                lampsOn: targets.count, lampsTotal: state.lamps.count,
                unreachable: state.lamps.count - targets.count,
                averageBrightness: level.percent))
            IntentRuntime.reloadSurfaces()
            return .result(dialog: IntentDialog(stringLiteral: "Set to \(level.percent)%."))
        } catch let error as VueError {
            return .result(dialog: IntentDialog(stringLiteral: error.errorDescription ?? "That didn't work."))
        }
    }
}

public struct RoomStatusIntent: AppIntent {
    public static let title: LocalizedStringResource = "What's on"
    public static let description = IntentDescription(
        "Says which lamps are on and how bright.", categoryName: "Lights")
    public static let openAppWhenRun: Bool = false

    public init() {}

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            let state = try await IntentRuntime.client().state()
            guard !state.lamps.isEmpty else { return .result(dialog: "There are no lamps set up.") }
            let lit = state.lit
            if lit.isEmpty {
                return .result(dialog: "Everything's off.")
            }
            let names = lit.map(\.name).joined(separator: ", ")
            var line = lit.count == state.lamps.count
                ? "All \(lit.count) lamps are on at \(state.averageBrightness)%."
                : "\(names) — \(state.averageBrightness)%."
            let out = state.lamps.filter { !$0.reachable }
            if !out.isEmpty {
                line += " I can't reach \(out.map(\.name).joined(separator: ", "))."
            }
            return .result(dialog: IntentDialog(stringLiteral: line))
        } catch let error as VueError {
            return .result(dialog: IntentDialog(stringLiteral: error.errorDescription ?? "That didn't work."))
        }
    }
}
