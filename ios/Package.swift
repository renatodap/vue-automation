// swift-tools-version: 6.0
import PackageDescription

/// Vue Lights — the native client.
///
/// One package, several targets. The graph below is the architecture; splitting
/// it into separate local packages later is mechanical, not a redesign.
///
/// **iOS only.** macOS used to be listed here so `swift test` could run the
/// colour maths without booting a simulator, and it cost more than it returned:
/// a bare `swift build` still failed on `VueApp` (`navigationBarTitleDisplayMode`,
/// `.topBarTrailing`, `textInputAutocapitalization` and `ControlCenter` are all
/// iOS-only), and SourceKit — which type-checks against the FIRST platform it can
/// resolve — filled the editor with "unavailable in macOS" errors for code that
/// builds perfectly. Those diagnostics were never about the app; they were about
/// a platform the app does not ship on.
///
/// The tests never needed it either: `Scripts/verify.sh` runs them through
/// `xcodebuild -scheme VueCoreTests -destination <simulator> test`, not through
/// `swift test`.
///
/// Build with:
///
///   ./Scripts/verify.sh
///
/// which sets DEVELOPER_DIR rather than needing `sudo xcode-select`.
let package = Package(
    name: "VueLights",
    // Spelled as a string rather than `.v26`: the enum case for a given OS only
    // exists in the PackageDescription that shipped with its SDK, so an older
    // toolchain fails to even PARSE this manifest — the error is
    // "'v26' is unavailable", pointing at the platform list rather than at the
    // toolchain, which is a confusing way to learn you are on the wrong Xcode.
    platforms: [.iOS("26.0")],
    products: [
        // Named VueLightsKit, NOT VueLights, on purpose. The Xcode app TARGET is
        // called VueLights, and when a package product shares that name
        // `xcodebuild -scheme VueLights` silently resolves to the library — it
        // reports BUILD SUCCEEDED, emits only .o/.swiftmodule, and leaves the
        // previously-installed .app untouched. Every "my change didn't take" is
        // that.
        .library(name: "VueLightsKit", targets: ["VueApp"]),

        // What the widget extension links, and deliberately NOT VueLightsKit.
        //
        // A widget extension gets its own copy of everything it links, and it is
        // memory-capped hard enough that the copy matters — pulling the whole
        // app in for the sake of one intent is how a widget starts getting
        // killed before it renders. `VueIntents` carries the intents, the entity
        // and the App Group mirror; `VueDesignSystem` carries the palette, so
        // the widget cannot drift away from the app's colours.
        .library(name: "VueIntentsKit", targets: ["VueIntents"]),
        .library(name: "VueDesignSystemKit", targets: ["VueDesignSystem"]),
    ],
    targets: [
        // Models, colour maths, errors. No UI, no networking.
        .target(name: "VueCore"),

        // Tokens and primitives, ported from the PWA's globals.css so the two
        // surfaces cannot drift apart visually.
        .target(name: "VueDesignSystem", dependencies: ["VueCore"]),

        // The HTTP client and the repository protocols, plus fixtures so every
        // screen renders with no server.
        .target(name: "VueRepositories", dependencies: ["VueCore"]),

        // App Intents. Its own target because a widget extension has to import
        // it without dragging the whole app in.
        .target(name: "VueIntents", dependencies: ["VueCore", "VueRepositories"]),

        // The shell and the screens.
        //
        // `Resources/` carries the room plate. It is `.process`, so the PNG is
        // optimised and addressed as `Bundle.module` — the app target cannot see
        // it any other way, because the file belongs to the package and not to
        // the .app.
        .target(
            name: "VueApp",
            dependencies: ["VueCore", "VueDesignSystem", "VueRepositories", "VueIntents"],
            resources: [.process("Resources")]),

        .testTarget(name: "VueCoreTests", dependencies: ["VueCore"]),
        .testTarget(name: "VueRepositoriesTests", dependencies: ["VueRepositories"]),
        // Covers the rule that decides what a widget is allowed to say about a
        // cached reading. That is invariant #3, and it is enforced by one
        // function rather than by everyone remembering.
        .testTarget(name: "VueIntentsTests", dependencies: ["VueIntents"]),
    ]
)
