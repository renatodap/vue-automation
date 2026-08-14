import Foundation

/// The one call that keeps Siri's entity list current, reachable from the
/// package that does not own it.
///
/// `AppShortcutsProvider` has to be declared in the app target — see
/// `App/Sources/VueShortcuts.swift` for what happens when it is not — but the
/// code that knows *when* the scene list changed lives in `VueApp`. Rather than
/// move the model into the app target, the app registers its updater here at
/// launch and the package calls through it.
///
/// `@MainActor` because the only caller is `AppModel`, which is already isolated
/// there; that also makes the stored closure safe under strict concurrency
/// without a lock.
@MainActor
public enum ShortcutSync {
    private static var updater: (@MainActor () -> Void)?

    /// Called once from `AppMain`. Registering late is the same failure as never
    /// registering: App Shortcut phrases that reference an entity parameter do
    /// not work at all until the system has fetched entities once.
    public static func register(_ updater: @escaping @MainActor () -> Void) {
        Self.updater = updater
    }

    /// No-op in the widget extension, which registers nothing and has no
    /// business updating the app's shortcut parameters anyway.
    public static func update() {
        updater?()
    }
}

/// The literal phrases Siri is listening for, as text.
///
/// Mirrors `VueShortcuts.appShortcuts` by hand, and has to: `AppShortcut`
/// phrases are compile-time string interpolations of a special
/// `AppShortcutPhraseToken` type, so there is no way to read them back out at
/// runtime and no way to build them from data. The app shows these on the scene
/// editor's "What Siri hears" row, because an invisible feature is an unused
/// one.
public enum ScenePhrasing {
    /// Every phrase must contain the app's name — the templates put it at a
    /// different position each time so at least one reads naturally out loud.
    public static func spoken(for name: String) -> [String] {
        [
            "Vue Lights \(name)",
            "Set \(name) with Vue Lights",
            "Turn on \(name) in Vue Lights",
        ]
    }
}
