import AppIntents
import Foundation
import VueCore
import VueRepositories

/// What a Control Center control is configured *with*.
///
/// A `ControlConfigurationIntent` is not an action — it never changes the room.
/// It is the little editor sheet Control Center shows when you long-press a
/// control, and its single parameter is a `SceneEntity`, so the picker is
/// populated by the same `SceneEntityQuery` that feeds Siri. One catalogue, one
/// query, four surfaces.
public struct SceneControlConfiguration: ControlConfigurationIntent {
    public static let title: LocalizedStringResource = "Choose a scene"
    public static let description = IntentDescription(
        "Pick which lighting scene this control sets.", categoryName: "Scenes")

    @Parameter(title: "Scene")
    public var scene: SceneEntity?

    public init() {}
    public init(scene: SceneEntity?) { self.scene = scene }

    public static var parameterSummary: some ParameterSummary {
        Summary("Set \(\.$scene)")
    }
}

/// The all-lights toggle behind `ControlWidgetToggle`.
///
/// A `SetValueIntent` rather than a plain `AppIntent`: a toggle hands the intent
/// the value the user just moved it *to*, so the control does not have to know
/// the current state to know what to do. Modelling this as "toggle" instead
/// would invert the room whenever the control's rendered state had drifted from
/// the house — which is exactly the case a lamp switched off at the wall
/// produces.
public struct SetLightsPowerIntent: SetValueIntent {
    public static let title: LocalizedStringResource = "Turn the lights on or off"
    public static let description = IntentDescription(
        "Switches every reachable lamp in the living room.", categoryName: "Lights")
    public static let openAppWhenRun: Bool = false

    @Parameter(title: "On")
    public var value: Bool

    public init() {}
    public init(value: Bool) { self.value = value }

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let client = IntentRuntime.client()
        do {
            let state = try await client.state()
            let targets = value
                ? state.reachable.map(\.entityId)
                : state.lit.map(\.entityId)
            guard !targets.isEmpty else {
                return .result(dialog: value ? "I can't reach any lamps." : "They're already off.")
            }
            if value {
                // Hold the level the room was last at rather than blasting to
                // full — a control tapped from a lock screen at midnight should
                // not be a floodlight.
                try await client.setLights(targets, on: true, brightness: state.averageBrightness)
            } else {
                try await client.setLights(targets, on: false)
            }
            RoomSnapshotStore.save(RoomSnapshot(
                lampsOn: value ? targets.count : 0,
                lampsTotal: state.lamps.count,
                unreachable: state.lamps.count - state.reachable.count,
                averageBrightness: value ? state.averageBrightness : 0))
            IntentRuntime.reloadSurfaces()
            return .result(dialog: value ? "Lights on." : "Lights off.")
        } catch let error as VueError {
            return .result(dialog: IntentDialog(
                stringLiteral: error.errorDescription ?? "That didn't work."))
        }
    }
}

/// The state a Control Center toggle renders itself with.
///
/// This one **does** hit the network, and that is the right call here rather
/// than a contradiction of the "no round trip in an extension" rule. The rule is
/// about a widget timeline, which the system rebuilds on its own schedule and
/// often while nothing is on screen. A control's value provider is called when
/// Control Center is actually being drawn for a user who is about to press it,
/// and a toggle is the one surface where showing the wrong value causes the
/// wrong action — it is a *labelled switch*, not a readout.
///
/// The timeout is short on purpose: Control Center will not wait, and a slow
/// answer is functionally the same as no answer.
public enum LightsPowerValue {
    public static func current() async -> Bool {
        do {
            return try await IntentRuntime.client(timeout: 4).state().anyOn
        } catch {
            // Fall back to the last thing the app saw, and only if it is recent
            // enough to be worth anything. Otherwise assume off — which makes
            // the control's next press "turn on", the harmless direction.
            guard let snapshot = RoomSnapshotStore.load(),
                  snapshot.freshness() != .expired else { return false }
            return snapshot.lampsOn > 0
        }
    }
}
