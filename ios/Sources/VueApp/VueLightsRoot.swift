import SwiftUI
import VueDesignSystem
import VueIntents

/// The app's root view, and everything that has to happen around it.
///
/// A `View` and not an `App`, and that distinction is load-bearing rather than
/// stylistic. When the package vended the `Scene` — `VueLightsApp().body` from
/// the app target — the Debug simulator build was fine and the Release archive
/// failed to link:
///
///     ld: warning: cannot link directly with 'SwiftUICore' because product
///         being built is not an allowed client of it
///     Undefined symbols: opaque type descriptor for
///         <<opaque return type of SwiftUI.View.task(name:priority:…)>>
///
/// An opaque `some Scene` forces the app target to resolve SwiftUI's internal
/// opaque type descriptors itself, and several of those now live in
/// SwiftUICore, which an app is not an allowed client of. A concrete `View`
/// crossing the boundary has no such problem: the opaque types stay inside the
/// package where they were built.
///
/// So `WindowGroup` lives in the app target, and everything else lives here.
public struct VueLightsRoot: View {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    public init() {}

    public var body: some View {
        RoomScreen()
            .environment(model)
            // Dark, always. This app's job is dimming lights in a dark room; a
            // cream screen at 9pm undoes the thing the user just asked for. The
            // palette is built for one mode and is honest about it.
            .preferredColorScheme(.dark)
            .task {
                await model.refresh()
                // On every launch, not only when scenes change. App Shortcut
                // phrases that reference an entity parameter do not work AT ALL
                // until the system has fetched entities once, so a fresh install
                // has no working Siri until something calls this.
                await model.refreshShortcuts()
            }
            .onChange(of: scenePhase) { _, phase in
                // Poll only while on screen. A phone in a pocket polling a
                // tailnet burns battery answering a question nobody asked.
                if phase == .active {
                    model.startPolling()
                } else {
                    model.stopPolling()
                }
            }
            .onOpenURL { url in
                // vuelights://scene/<entity or config id>
                guard url.host() == "scene",
                      let id = url.pathComponents.first(where: { $0 != "/" }),
                      let scene = model.state.scenes.first(where: {
                          $0.entityId == id || $0.id == id
                      }) else { return }
                Task { await model.activate(scene) }
            }
    }
}
