import SwiftUI
import VueApp

/// The iOS app target's entry point.
///
/// It owns the `WindowGroup` and nothing else. That split is deliberate: an
/// opaque `some Scene` vended from the package makes the app target responsible
/// for resolving SwiftUI's internal opaque type descriptors, several of which
/// now live in SwiftUICore — which an app is not an allowed client of. Debug
/// builds fine; the Release archive fails to link. See `VueLightsRoot`.
@main
struct AppMain: App {
    var body: some Scene {
        WindowGroup {
            VueLightsRoot()
        }
    }
}
