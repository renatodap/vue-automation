import AppIntents
import VueIntents

/// What Siri is trained to listen for.
///
/// **This type has to live in the app TARGET, not in the package**, and that is
/// not a style choice. `appintentsmetadataprocessor` happily merges intents and
/// entities up from a linked package — every intent below is defined in
/// `VueIntents` and resolves fine — but `AppShortcutsProvider` conformances are
/// only extracted from the target being built. With this struct in the package,
/// the app's `Metadata.appintents` carried `autoShortcuts: []` and the build log
/// said, in passing and without failing:
///
///     appintentsnltrainingprocessor … No AppShortcuts found - Skipping.
///
/// The app built, archived, uploaded and installed. Siri simply never answered
/// to anything. That is the same class of silent death as omitting
/// `\(.applicationName)`, and it is invisible in exactly the same way — so the
/// check is: after any build, that line must NOT say "No AppShortcuts found".
///
/// Two ceilings apply, both counted expansively: **10 App Shortcuts** and
/// **1,000 total phrases**, where a phrase with a parameter counts once per
/// possible value. Five shortcuts here, and roughly 3×(scenes) + 5 + 4 phrases —
/// about forty against a thousand, so scenes can grow by an order of magnitude
/// before it matters.
///
/// **Every phrase must contain `\(.applicationName)`.** Leaving it out still
/// compiles and the phrase simply never matches at runtime, which is the single
/// most common way this feature quietly dies. `INAlternativeAppNames` in
/// Info.plist gives Siri more than one way to hear the name — "Vue" alone is
/// routinely heard as "view".
///
/// The literal phrasings are mirrored, as plain strings, in
/// `ScenePhrasing.spoken(for:)` so the app can show the user what it actually
/// listens for. Change one, change the other.
struct VueShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ActivateSceneIntent(),
            phrases: [
                "\(.applicationName) \(\.$scene)",
                "Set \(\.$scene) with \(.applicationName)",
                "Turn on \(\.$scene) in \(.applicationName)",
            ],
            shortTitle: "Set a scene",
            systemImageName: "lightbulb.fill")

        AppShortcut(
            intent: AllLightsOffIntent(),
            phrases: [
                "Turn off \(.applicationName)",
                "Lights out in \(.applicationName)",
            ],
            shortTitle: "All off",
            systemImageName: "power")

        AppShortcut(
            intent: AllLightsOnIntent(),
            phrases: [
                "Turn on \(.applicationName)",
            ],
            shortTitle: "All on",
            systemImageName: "sun.max.fill")

        AppShortcut(
            intent: SetBrightnessIntent(),
            phrases: [
                "Set \(.applicationName) to \(\.$level)",
            ],
            shortTitle: "Set brightness",
            systemImageName: "sun.max")

        AppShortcut(
            intent: RoomStatusIntent(),
            phrases: [
                "What's on in \(.applicationName)",
            ],
            shortTitle: "What's on",
            systemImageName: "questionmark.circle")
    }
}
