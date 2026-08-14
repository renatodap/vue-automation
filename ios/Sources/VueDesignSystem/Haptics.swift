import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// The feedback a web app structurally cannot give.
///
/// This matters more here than in most apps: the user is looking at the *room*,
/// not at the screen. A lamp that takes a second to respond over Zigbee leaves a
/// gap where nothing has happened yet, and a tap that lands with no confirmation
/// gets repeated — which is how you end up toggling a lamp twice and concluding
/// the app is broken.
///
/// `@MainActor` because `UIFeedbackGenerator` is, and the generators are created
/// per call rather than held: `prepare()`-and-hold buys a few milliseconds and
/// costs a retained haptic engine for a screen that is idle most of the time.
@MainActor
public enum Haptics {
    /// A lamp changed state.
    public static func tap() {
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }

    /// Something bigger landed — a bulk action, a drop.
    public static func thud() {
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        #endif
    }

    /// Crossing a detent mid-drag. Deliberately the quietest of the three:
    /// it fires repeatedly during a gesture, and a heavy tick at every 25%
    /// turns a slider into a rattle.
    public static func detent() {
        #if canImport(UIKit)
        UISelectionFeedbackGenerator().selectionChanged()
        #endif
    }

    public static func success() {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }

    public static func warn() {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        #endif
    }
}

/// Fires `detent()` when a value crosses one of the quarter marks.
///
/// Held as a struct rather than done inline so the "did we already tick for
/// this step" bookkeeping lives in one place — doing it per gesture is how you
/// get a tick on every frame near a boundary.
public struct DetentTicker {
    private var lastStep: Int?
    public init() {}

    /// `step` is the value bucketed to 25s. Returns true when it moved.
    @MainActor
    public mutating func track(_ value: Int, every stride: Int = 25) {
        let step = value / stride
        defer { lastStep = step }
        guard let lastStep, lastStep != step else { return }
        Haptics.detent()
    }

    public mutating func reset() { lastStep = nil }
}
