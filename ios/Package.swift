// swift-tools-version: 6.0
import PackageDescription

/// Vue Lights — the native client.
///
/// One package, several targets. The graph below is the architecture; splitting
/// it into separate local packages later is mechanical, not a redesign.
///
/// macOS is in `platforms` for the TEST targets, not because the app runs there.
/// `VueCore` and `VueRepositories` are macOS-clean, which is what lets
/// `swift test` exercise the colour maths and the decoding without booting a
/// simulator. `VueApp` is iOS-only — SwiftUI's `fullScreenCover` and
/// `.glassEffect` do not exist on macOS — so a bare `swift build` WILL fail on
/// it, and that failure says nothing about the app. Build with:
///
///   ./Scripts/verify.sh
///
/// which sets DEVELOPER_DIR rather than needing `sudo xcode-select`.
let package = Package(
    name: "VueLights",
    // Spelled as strings rather than `.v26` / `.v14`: the enum case for a given
    // OS only exists in the PackageDescription that shipped with its SDK, so an
    // older toolchain fails to even PARSE this manifest — the error is
    // "'v26' is unavailable", pointing at the platform list rather than at the
    // toolchain, which is a confusing way to learn you are on the wrong Xcode.
    platforms: [.iOS("26.0"), .macOS("14.0")],
    products: [
        // Named VueLightsKit, NOT VueLights, on purpose. The Xcode app TARGET is
        // called VueLights, and when a package product shares that name
        // `xcodebuild -scheme VueLights` silently resolves to the library — it
        // reports BUILD SUCCEEDED, emits only .o/.swiftmodule, and leaves the
        // previously-installed .app untouched. Every "my change didn't take" is
        // that.
        .library(name: "VueLightsKit", targets: ["VueApp"]),
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
    ]
)
