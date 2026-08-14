import SwiftUI
import VueApp
import VueIntents

/// The iOS app target's entry point.
///
/// It owns the `WindowGroup` and nothing else. That split is deliberate: an
/// opaque `some Scene` vended from the package makes the app target responsible
/// for resolving SwiftUI's internal opaque type descriptors, several of which
/// now live in SwiftUICore — which an app is not an allowed client of. Debug
/// builds fine; the Release archive fails to link. See `VueLightsRoot`.
@main
struct AppMain: App {
    init() {
        // `VueShortcuts` can only live in this target (see its own comment), and
        // `AppModel` — which knows when the scene list changed — lives in the
        // package. This hands the package the one call it cannot make itself.
        //
        // In `init`, not in `.task`: the model refreshes on first appearance and
        // would otherwise find nothing registered on exactly the launch that
        // matters most, the first one.
        ShortcutSync.register { VueShortcuts.updateAppShortcutParameters() }
    }

    var body: some Scene {
        WindowGroup {
            VueLightsRoot()
        }
    }
}
