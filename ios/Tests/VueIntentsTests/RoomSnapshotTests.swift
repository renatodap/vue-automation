import Foundation
import Testing
@testable import VueIntents

/// The widget cannot re-read the house on every timeline refresh, so it renders
/// from a cache — and the repo's third invariant says a cached light state must
/// never be shown as current, because a stale reading is worse than an error:
/// the user acts on it.
///
/// `statusLine` is the whole of that policy. These tests are the enforcement.
@Suite struct RoomSnapshotTests {
    private func snapshot(
        ageSeconds: TimeInterval, on: Int = 2, total: Int = 4, unreachable: Int = 0
    ) -> RoomSnapshot {
        RoomSnapshot(
            lampsOn: on, lampsTotal: total, unreachable: unreachable,
            averageBrightness: 60,
            capturedAt: Date(timeIntervalSince1970: 1_000_000 - ageSeconds))
    }

    private let now = Date(timeIntervalSince1970: 1_000_000)

    @Test func afreshReadingIsStatedPlainly() {
        #expect(snapshot(ageSeconds: 5).statusLine(now: now) == "2 of 4 on")
    }

    /// Past a minute the number is still useful, but only if it carries its age.
    /// Printing "2 of 4 on" about a ten-minute-old reading is the exact failure
    /// the invariant names.
    @Test func aDatedReadingCarriesItsAge() {
        let line = snapshot(ageSeconds: 600).statusLine(now: now)
        #expect(line == "2 of 4 on · 10 min ago")
    }

    /// Past an hour it is dropped entirely. Nil means the widget prints nothing,
    /// which is the honest rendering of "I don't know" — an hour-old reading of
    /// a room somebody has walked through is not evidence of anything.
    @Test func anExpiredReadingSaysNothingAtAll() {
        #expect(snapshot(ageSeconds: 7200).statusLine(now: now) == nil)
        #expect(snapshot(ageSeconds: 7200).freshness(now: now) == .expired)
    }

    /// Deliberately at the fresh end only: unreachable lamps are a live fact
    /// about the mesh, and appending them to a reading already labelled "10 min
    /// ago" implies we checked just now.
    @Test func unreachableLampsAreNamedOnlyWhileCurrent() {
        #expect(snapshot(ageSeconds: 5, unreachable: 1).statusLine(now: now)
            == "2 of 4 on · 1 unreachable")
        #expect(snapshot(ageSeconds: 600, unreachable: 1).statusLine(now: now)
            == "2 of 4 on · 10 min ago")
    }

    @Test func allOffReadsAsAllOff() {
        #expect(snapshot(ageSeconds: 5, on: 0).statusLine(now: now) == "All off")
    }

    /// A phone with no lamps configured has nothing to report, and "0 of 0 on"
    /// is worse than silence.
    @Test func noLampsMeansNoLine() {
        #expect(snapshot(ageSeconds: 5, on: 0, total: 0).statusLine(now: now) == nil)
    }

    /// Firing a scene changes the room to something we did not read back. The
    /// intent stamps the cache to `distantPast` rather than leaving the old
    /// numbers in place, and that has to land as "expired", not as "very old".
    @Test func aRoomWeJustChangedReportsNothing() {
        let invalidated = RoomSnapshot(
            lampsOn: 2, lampsTotal: 4, unreachable: 0,
            averageBrightness: 60, capturedAt: .distantPast)
        #expect(invalidated.statusLine(now: now) == nil)
    }
}

/// The scene list is not device state — a cached one is just a list — but it IS
/// what Siri and every control resolve against, so its change-detection has to
/// be exact. Too loose and `updateAppShortcutParameters()` never fires; too
/// tight and it fires every five seconds until the system starts ignoring it.
@Suite struct SceneCatalogueSignatureTests {
    private func catalogue(_ entries: [SceneCatalogueEntry]) -> SceneCatalogue {
        SceneCatalogue(scenes: entries, updatedAt: .distantPast)
    }

    @Test func identicalListsAgree() {
        let a = catalogue([SceneCatalogueEntry(entityId: "scene.a", label: "Movie")])
        let b = catalogue([SceneCatalogueEntry(entityId: "scene.a", label: "Movie")])
        #expect(a.signature == b.signature)
    }

    /// The aliases ARE the feature. A change here has to reach Siri, and Apple
    /// calls out synonyms specifically as needing the update call.
    @Test func changingAnAliasChangesTheSignature() {
        let before = catalogue([SceneCatalogueEntry(entityId: "scene.a", label: "Movie")])
        let after = catalogue([
            SceneCatalogueEntry(entityId: "scene.a", label: "Movie", aliases: ["netflix"])
        ])
        #expect(before.signature != after.signature)
    }

    @Test func renamingChangesTheSignature() {
        let before = catalogue([SceneCatalogueEntry(entityId: "scene.a", label: "Movie")])
        let after = catalogue([SceneCatalogueEntry(entityId: "scene.a", label: "Cinema")])
        #expect(before.signature != after.signature)
    }

    @Test func addingASceneChangesTheSignature() {
        let before = catalogue([SceneCatalogueEntry(entityId: "scene.a", label: "Movie")])
        let after = catalogue([
            SceneCatalogueEntry(entityId: "scene.a", label: "Movie"),
            SceneCatalogueEntry(entityId: "scene.b", label: "Late"),
        ])
        #expect(before.signature != after.signature)
    }

    /// An unconfigured control must never activate anything. The entity exists
    /// so the control has something to render before it is set up.
    @Test func theUnconfiguredEntityRefusesToRun() {
        #expect(SceneEntity.unconfigured.isConfigured == false)
        #expect(SceneEntity(SceneCatalogueEntry(entityId: "scene.a", label: "Movie"))
            .isConfigured == true)
    }
}
