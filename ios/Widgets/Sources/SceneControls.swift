import AppIntents
import SwiftUI
import VueDesignSystem
import VueIntents
import WidgetKit

// MARK: - One scene, one press

/// A Control Center / Lock Screen / Action Button control that fires a scene.
///
/// It is configurable: long-pressing it in Control Center opens
/// `SceneControlConfiguration`, whose one parameter is a `SceneEntity` resolved
/// through the same query that feeds Siri. So adding a scene in the app adds it
/// to the control picker, to Spotlight, to Shortcuts and to Siri at once,
/// without a rebuild — that is the payoff for putting everything behind one
/// intent instead of five.
///
/// The control can be placed more than once, each copy set to a different scene,
/// which is what makes "Movie" and "Late" both reachable from a locked phone.
struct SceneControl: ControlWidget {
    static let kind = "me.renatodap.vuelights.control.scene"

    var body: some ControlWidgetConfiguration {
        AppIntentControlConfiguration(
            kind: Self.kind,
            provider: Provider()
        ) { scene in
            ControlWidgetButton(action: ActivateSceneIntent(scene: scene)) {
                Label(scene.label, systemImage: scene.symbol)
            }
            .tint(Palette.accent)
        }
        .displayName("Set a scene")
        .description("Applies one of your lighting scenes without opening the app.")
    }

    struct Provider: AppIntentControlValueProvider {
        /// The gallery preview, before the user has chosen anything.
        func previewValue(configuration: SceneControlConfiguration) -> SceneEntity {
            configuration.scene ?? SceneCatalogueStore.load().scenes.first.map(SceneEntity.init)
                ?? .unconfigured
        }

        /// Reads the App Group mirror — no network. The control's job is to
        /// name a scene, and the scene list is not device state, so a cached one
        /// is not a stale reading; it is just a list.
        func currentValue(configuration: SceneControlConfiguration) async throws -> SceneEntity {
            // Re-resolve against the mirror rather than trusting the stored
            // configuration blindly: a scene deleted since the control was
            // placed must not still look live. `ActivateSceneIntent` refuses to
            // run against an unconfigured entity, so the failure is spoken
            // rather than silent.
            guard let chosen = configuration.scene else {
                return SceneCatalogueStore.load().scenes.first.map(SceneEntity.init) ?? .unconfigured
            }
            let known = SceneCatalogueStore.load().scenes.first { $0.entityId == chosen.id }
            return known.map(SceneEntity.init) ?? chosen
        }
    }
}

// MARK: - The room, on or off

/// The one control worth having when you cannot remember which scene you want.
///
/// A `ControlWidgetToggle` rather than two buttons: Control Center renders a
/// toggle with state, and a switch that shows the room is off is a different
/// object from a button labelled "off" — you can read the first one without
/// pressing it.
struct AllLightsControl: ControlWidget {
    static let kind = "me.renatodap.vuelights.control.power"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind, provider: Provider()) { isOn in
            ControlWidgetToggle(
                "Living Room",
                isOn: isOn,
                action: SetLightsPowerIntent()
            ) { on in
                Label(on ? "On" : "Off", systemImage: on ? "lightbulb.fill" : "lightbulb")
            }
            .tint(Palette.accent)
        }
        .displayName("Living Room lights")
        .description("Turns every reachable lamp on or off.")
    }

    struct Provider: ControlValueProvider {
        /// What the gallery shows. Off, so the preview reads as "press to turn
        /// on" rather than promising a state it has not checked.
        let previewValue = false

        func currentValue() async throws -> Bool {
            await LightsPowerValue.current()
        }
    }
}
