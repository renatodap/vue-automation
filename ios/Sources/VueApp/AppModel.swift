import Foundation
import Observation
import SwiftUI
import VueCore
import VueDesignSystem
import VueIntents
import VueRepositories

/// Everything the app knows, in one place.
///
/// A class and `@MainActor`, not `@State` on the `App` struct. An `App` is a
/// value type: an async bootstrap captures a copy, writes into it, and the write
/// is invisible on the next line. That exact mistake cost a day in the sibling
/// project — the app signed in, then displayed fixture data forever, with no
/// error anywhere.
@Observable
@MainActor
public final class AppModel {
    public private(set) var state: HouseState = .empty
    public private(set) var status: Status = .loading
    public private(set) var notice: String?

    /// The lamp whose detail sheet is open.
    public var inspecting: Lamp?

    /// A lamp being dragged onto another to copy its settings.
    ///
    /// Lives on the model rather than in the dragged marker's own `@State`
    /// because every OTHER marker has to know about it — the one under the
    /// finger has to light up as a drop target, and a lamp cannot see its
    /// sibling's local state.
    public var carry: Carry?

    public struct Carry: Equatable, Sendable {
        public let source: String
        /// In the room canvas's coordinate space.
        public var location: CGPoint
        /// The lamp currently under the finger, if any.
        public var target: String?
    }
    public var editingScene: LightScene?
    public var showingSettings = false

    public enum Status: Equatable, Sendable {
        case loading
        case live
        /// We have data, but the last refresh failed. Never a blank screen over
        /// numbers we already have — say it is old and keep showing it.
        case stale(String)
        /// We have nothing and cannot get it.
        case down(String)
    }

    @ObservationIgnored private var client: APIClient
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    /// Lamps mid-gesture. Their values come from the finger, not the server, or
    /// a poll landing mid-drag yanks the slider back under the thumb.
    @ObservationIgnored private var held: Set<String> = []
    /// The catalogue signature the system was last told about.
    @ObservationIgnored private var lastPublished: String?
    @ObservationIgnored private var lastSummary: String?
    @ObservationIgnored private var lastWidgetReload = Date.distantPast

    /// Written to the SHARED defaults suite, not to `UserDefaults.standard`.
    /// The widget extension and the Control Center control build their own
    /// clients in their own processes, and `standard` there is a different
    /// container — pointing the app at a laptop while the widget keeps calling
    /// production is the kind of drift that takes an hour to spot.
    public var baseURL: String {
        didSet {
            VueSettings.baseURL = baseURL
            let url = URL(string: baseURL) ?? VueAPI.defaultBaseURL
            client = APIClient(baseURL: url)
            Task { await refresh() }
        }
    }

    public init() {
        let stored = VueSettings.baseURL
        self.baseURL = stored ?? VueAPI.defaultBaseURL.absoluteString
        let url = stored.flatMap(URL.init(string:)) ?? VueAPI.defaultBaseURL
        self.client = APIClient(baseURL: url)
    }

    // MARK: - Loading

    /// Poll only while the app is on screen.
    ///
    /// A phone in a pocket polling every few seconds burns battery answering a
    /// question nobody is asking.
    public func startPolling() {
        poll?.cancel()
        poll = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    public func stopPolling() {
        poll?.cancel()
        poll = nil
    }

    public func refresh() async {
        do {
            let fresh = try await client.state()
            // Do not stomp a lamp the user is currently dragging.
            state = held.isEmpty ? fresh : merge(fresh, keeping: held)
            status = .live
            await publishToSharedSurfaces(fresh)
        } catch {
            let message = (error as? VueError)?.errorDescription ?? "Something went wrong."
            status = state.lamps.isEmpty ? .down(message) : .stale(message)
        }
    }

    /// Push what the other processes need into the App Group container.
    ///
    /// The app is the ONLY process that talks to the server on a schedule. Siri,
    /// the widget and the Control Center controls all read from what it leaves
    /// behind, so this is not bookkeeping — it is the thing that makes those
    /// surfaces work at all.
    private func publishToSharedSurfaces(_ fresh: HouseState) async {
        // Keep Siri's list current. The alternative is a scene that exists in
        // the app and not in Siri until the next launch.
        let catalogue = SceneCatalogueStore.merge(scenes: fresh.scenes)
        RoomSnapshotStore.save(RoomSnapshot(fresh))

        // Gate both system calls on the catalogue actually changing. They are
        // rate-limited, and firing them every five seconds is how they come to
        // be ignored at the moment they matter.
        let signature = catalogue.signature
        if signature != lastPublished {
            lastPublished = signature
            await refreshShortcuts()
            IntentRuntime.reloadSurfaces()
            return
        }

        // The scene list is unchanged but the room moved. Redraw the widget at
        // most twice a minute so its status line does not go visibly stale
        // while the app is open next to it.
        let summary = fresh.summary
        if summary != lastSummary, Date.now.timeIntervalSince(lastWidgetReload) > 30 {
            lastSummary = summary
            lastWidgetReload = .now
            IntentRuntime.reloadSurfaces()
        }
    }

    /// Keep the in-flight lamps' local values, take everything else from the
    /// server.
    private func merge(_ fresh: HouseState, keeping ids: Set<String>) -> HouseState {
        let current = Dictionary(uniqueKeysWithValues: state.lamps.map { ($0.entityId, $0) })
        let lamps = fresh.lamps.map { ids.contains($0.entityId) ? (current[$0.entityId] ?? $0) : $0 }
        return HouseState(
            scenes: fresh.scenes, lamps: lamps,
            automations: fresh.automations, unreachableCount: fresh.unreachableCount)
    }

    /// Tell the system the entity list changed.
    ///
    /// Required, not optional: App Shortcut phrases that reference an entity
    /// parameter do not work at all until the system has fetched entities once.
    /// Skipping this on a fresh install leaves Siri silently dead.
    ///
    /// Goes through `ShortcutSync` rather than calling
    /// `VueShortcuts.updateAppShortcutParameters()` directly, because the
    /// provider has to be declared in the app target — a provider inside this
    /// package is not extracted at build time and yields an app with no Siri
    /// phrases at all.
    public func refreshShortcuts() async {
        ShortcutSync.update()
    }

    // MARK: - Optimistic local edits

    /// Paint the change immediately, then send it.
    ///
    /// A lamp that waits for a tailnet round trip before moving reads as broken,
    /// and the room itself is the real feedback anyway.
    private func apply(_ change: (inout Lamp) -> Void, to ids: Set<String>) {
        let lamps = state.lamps.map { lamp -> Lamp in
            guard ids.contains(lamp.entityId) else { return lamp }
            var copy = lamp
            change(&copy)
            return copy
        }
        state = HouseState(
            scenes: state.scenes, lamps: lamps,
            automations: state.automations, unreachableCount: state.unreachableCount)
    }

    public func beginGesture(on ids: [String]) { held.formUnion(ids) }
    public func endGesture(on ids: [String]) { held.subtract(ids) }

    // MARK: - Actions

    public func toggle(_ lamp: Lamp) async {
        // An unreachable lamp is the single most common real state in this room
        // and it currently reads as the app being broken. Say what it is.
        guard lamp.reachable else {
            Haptics.warn()
            flash(lamp.trouble ?? "\(lamp.name) isn't responding")
            return
        }
        Haptics.tap()
        let turningOn = !lamp.on
        apply({ $0 = Lamp(
            entityId: $0.entityId, name: $0.name, reachable: $0.reachable, on: turningOn,
            brightness: turningOn ? ($0.brightness ?? 60) : nil, kelvin: $0.kelvin,
            minKelvin: $0.minKelvin, maxKelvin: $0.maxKelvin, rgb: $0.rgb, hs: $0.hs,
            supportsColor: $0.supportsColor, colorMode: $0.colorMode) },
              to: [lamp.entityId])
        await send { try await self.client.setLights([lamp.entityId], on: turningOn) }
    }

    public func setBrightness(_ value: Int, on ids: [String], commit: Bool) async {
        apply({ $0 = withBrightness($0, value) }, to: Set(ids))
        guard commit else { return }
        await send { try await self.client.setLights(ids, on: true, brightness: value) }
    }

    public func setKelvin(_ value: Int, on ids: [String], commit: Bool) async {
        apply({ $0 = withKelvin($0, value) }, to: Set(ids))
        guard commit else { return }
        await send { try await self.client.setLights(ids, on: true, kelvin: value) }
    }

    public func setColor(hue: Double, saturation: Double, on ids: [String], commit: Bool) async {
        apply({ $0 = withHS($0, hue: hue, saturation: saturation) }, to: Set(ids))
        guard commit else { return }
        await send { try await self.client.setLights(ids, on: true, hs: [hue, saturation]) }
    }

    public func allOff() async {
        let ids = state.lit.map(\.entityId)
        guard !ids.isEmpty else { return }
        captureUndo("All off")
        apply({ $0 = withOn($0, false) }, to: Set(ids))
        Haptics.thud()
        await send { try await self.client.setLights(ids, on: false) }
    }

    public func allOn() async {
        let ids = state.reachable.map(\.entityId)
        guard !ids.isEmpty else { return }
        captureUndo("All on")
        let level = state.averageBrightness
        apply({ $0 = withBrightness(withOn($0, true), level) }, to: Set(ids))
        Haptics.thud()
        await send { try await self.client.setLights(ids, on: true, brightness: level) }
    }

    public func activate(_ scene: LightScene) async {
        // A scene rewrites the whole room in one go, which is exactly the kind
        // of change worth being able to take back.
        captureUndo(scene.label)
        do {
            let result = try await client.activate(scene: scene.entityId)
            // Report partial application. HA applies a scene to what it can
            // reach and stays silent about the rest, and silence reads as
            // success.
            flash(result.unreachable.isEmpty
                  ? scene.label
                  : "\(scene.label) — couldn't reach \(result.unreachable.joined(separator: ", "))")
        } catch {
            flash((error as? VueError)?.errorDescription ?? "That didn't go through")
        }
        await refresh()
    }

    public func captureScene(named name: String) async {
        do {
            _ = try await client.captureScene(name: name)
            flash("Saved “\(name)”")
        } catch {
            flash((error as? VueError)?.errorDescription ?? "Couldn't save that")
        }
        await refresh()
    }

    public func deleteScene(_ scene: LightScene) async {
        guard let id = scene.id else {
            flash("That scene wasn't created here, so it can't be deleted from the app")
            return
        }
        do {
            try await client.deleteScene(id: id)
            flash("Deleted “\(scene.label)”")
        } catch {
            flash((error as? VueError)?.errorDescription ?? "Couldn't delete that")
        }
        await refresh()
    }

    /// Store the spoken synonyms for a scene and tell the system.
    public func setAliases(_ aliases: [String], for scene: LightScene) async {
        SceneCatalogueStore.setAliases(aliases, for: scene.entityId)
        // Unconditional, and not gated on the signature check in
        // `publishToSharedSurfaces`: synonyms are explicitly called out by Apple
        // as needing this call, and the whole no-code feature is dead without
        // it. Also reset the gate so the next poll does not skip the update.
        lastPublished = SceneCatalogueStore.load().signature
        await refreshShortcuts()
        flash(aliases.isEmpty ? "Cleared the extra names" : "Siri will listen for \(aliases.count) more")
    }

    public func aliases(for scene: LightScene) -> [String] {
        SceneCatalogueStore.load().scenes
            .first { $0.entityId == scene.entityId }?.aliases ?? []
    }

    // MARK: - Undo

    /// The room as it was before the last bulk change.
    ///
    /// This is built first and deliberately, because it is what makes every
    /// other gesture below safe to try. "Copy this lamp onto that one" and
    /// "match everything to this" are destructive in a way a single toggle is
    /// not — they overwrite four bulbs' worth of state that took a while to get
    /// right — and an interface that can only go forwards makes people cautious
    /// with exactly the features that are supposed to be fast.
    public struct RoomUndo: Sendable, Equatable {
        /// What is being taken back, in the user's words. "Undo" alone makes
        /// them guess what they are about to reverse.
        public let label: String
        let lamps: [Lamp]
    }

    public private(set) var undoState: RoomUndo?
    @ObservationIgnored private var undoTask: Task<Void, Never>?

    /// Snapshots every reachable lamp. Unreachable ones are left out: we do not
    /// know what they were, and restoring a guess is worse than restoring
    /// nothing.
    private func captureUndo(_ label: String) {
        undoState = RoomUndo(label: label, lamps: state.reachable)
        undoTask?.cancel()
        undoTask = Task { [weak self] in
            // Thirty seconds. Long enough to look at the room and change your
            // mind, short enough that the bar is not still offering to undo
            // something from before you made a coffee.
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            self?.undoState = nil
        }
    }

    public func revert() async {
        guard let snapshot = undoState else { return }
        undoState = nil
        undoTask?.cancel()
        Haptics.success()
        flash("Back to before “\(snapshot.label)”")
        await push(snapshot.lamps.map { ($0, LampSetting($0)) })
        await refresh()
    }

    // MARK: - Copying settings between lamps

    /// Exactly what to send for one lamp — and never more than one colour key.
    ///
    /// `hs_color` and `color_temp_kelvin` are mutually exclusive modes on the
    /// bulb. Sending both lets Home Assistant choose which wins, and which one
    /// it picks is not something the user can predict, so the room comes back
    /// subtly wrong and the copy looks unreliable rather than ambiguous.
    struct LampSetting: Hashable, Sendable {
        let on: Bool
        let brightness: Int?
        let kelvin: Int?
        let hs: [Double]?

        init(on: Bool, brightness: Int?, kelvin: Int?, hs: [Double]?) {
            self.on = on
            self.brightness = brightness
            self.kelvin = kelvin
            self.hs = hs
        }

        /// A lamp's own current settings, for restoring it exactly.
        init(_ lamp: Lamp) {
            guard lamp.on else {
                self.init(on: false, brightness: nil, kelvin: nil, hs: nil)
                return
            }
            let inColour = lamp.colorMode == "hs" || (lamp.hs != nil && lamp.kelvin == nil)
            self.init(
                on: true,
                brightness: lamp.brightness ?? 60,
                kelvin: inColour ? nil : lamp.kelvin,
                hs: inColour ? lamp.hs : nil)
        }
    }

    /// Source's look, clamped into what the target bulb can actually do.
    ///
    /// The clamp is not defensive padding: these ZL1s report 2000–6493 K and a
    /// value outside a bulb's own range is rejected in silence, which is
    /// indistinguishable from the copy not having happened. Two bulb models in
    /// one room is all it takes.
    private func setting(from source: Lamp, for target: Lamp) -> LampSetting {
        let base = LampSetting(source)
        guard let kelvin = base.kelvin else { return base }
        return LampSetting(
            on: base.on,
            brightness: base.brightness,
            kelvin: max(target.minKelvin, min(target.maxKelvin, kelvin)),
            hs: nil)
    }

    /// Copy one lamp's look onto others.
    ///
    /// The interaction this exists for is dragging one lamp onto another on the
    /// map — the fastest way to say "like that one" without reading a single
    /// number off either.
    ///
    /// The authoritative copy happens on the SERVER (`POST /api/copy`), which
    /// re-reads the source rather than trusting this process's copy of it. Our
    /// local state is up to a poll interval old, and a copy taken from a stale
    /// source propagates a colour the lamp no longer has — the two then
    /// disagree on screen until the next refresh, which looks like the copy
    /// half-worked. The local paint below is for immediacy only; the server
    /// decides what actually lands.
    public func copySettings(from source: Lamp, to targets: [Lamp]) async {
        let receivers = targets.filter { $0.reachable && $0.entityId != source.entityId }
        guard !receivers.isEmpty else { return }
        guard source.reachable else {
            Haptics.warn()
            flash(source.trouble ?? "\(source.name) isn't responding")
            return
        }
        let everything = receivers.count == state.reachable.count - 1
        captureUndo(receivers.count == 1
            ? "\(source.name) → \(receivers[0].name)"
            : "Match all to \(source.name)")

        // Paint first so the room map moves under the thumb that just let go.
        let pairs = receivers.map { ($0, setting(from: source, for: $0)) }
        for (lamp, setting) in pairs {
            apply({ $0 = applying(setting, to: $0) }, to: [lamp.entityId])
        }
        Haptics.success()

        do {
            let result = try await client.copy(
                from: source.entityId,
                to: everything ? .all : .lamps(receivers.map(\.entityId)))
            // Report partial application, as everywhere else: HA applies what
            // it can reach and stays silent about the rest.
            if result.unreachable.isEmpty {
                flash(result.copied.count == 1
                    ? "Copied \(source.name) → \(result.copied[0])"
                    : "Matched \(result.copied.count) lamps to \(source.name)")
            } else {
                flash("Copied \(source.name) — couldn't reach \(result.unreachable.joined(separator: ", "))")
            }
        } catch {
            // The route is newer than some deployments. Falling back to the
            // locally-computed patch keeps the gesture working against an older
            // server instead of failing in a way the user would read as the
            // feature being broken.
            await push(pairs)
            flash(receivers.count == 1
                ? "Copied \(source.name) → \(receivers[0].name)"
                : "Matched \(receivers.count) lamps to \(source.name)")
        }
        await refresh()
    }

    public func matchAll(to source: Lamp) async {
        await copySettings(from: source, to: state.reachable)
    }

    /// One lamp on, everything else off.
    public func solo(_ lamp: Lamp) async {
        guard lamp.reachable else { return }
        let others = state.reachable.filter { $0.entityId != lamp.entityId }
        captureUndo("Just \(lamp.name)")

        apply({ $0 = withOn($0, false) }, to: Set(others.map(\.entityId)))
        apply({ $0 = withOn($0, true) }, to: [lamp.entityId])
        Haptics.thud()
        flash("Just \(lamp.name)")

        let live = state.lamps.first { $0.entityId == lamp.entityId } ?? lamp
        await push(others.map { ($0, LampSetting(on: false, brightness: nil, kelvin: nil, hs: nil)) }
                   + [(live, LampSetting(live))])
    }

    // MARK: - Relative adjustment

    /// Scale every lit lamp by the same proportion.
    ///
    /// An absolute master — "everything to 40%" — flattens the room into one
    /// value and destroys whatever shape the scene had. Scaling keeps the
    /// relationship between the lamps, which is the thing that made the scene
    /// worth saving in the first place.
    ///
    /// `anchors` is the room as it was when the finger went down. Applying the
    /// factor to live state instead compounds it against our own writes and the
    /// lamps run away under the thumb.
    public func scaleBrightness(
        factor: Double, from anchors: [String: Int], commit: Bool
    ) async {
        var groups: [Int: [String]] = [:]
        for (id, anchor) in anchors {
            let value = max(1, min(100, Int((Double(anchor) * factor).rounded())))
            groups[value, default: []].append(id)
        }
        for (value, ids) in groups {
            apply({ $0 = withBrightness($0, value) }, to: Set(ids))
        }
        guard commit else { return }
        // Grouped, so four lamps that land on the same number cost one round
        // trip. Mid-drag this is the difference between a responsive room and a
        // Zigbee mesh with a queue.
        for (value, ids) in groups {
            await send { try await self.client.setLights(ids, on: true, brightness: value) }
        }
    }

    /// The room as it is now, for a gesture that is about to start.
    public func brightnessAnchors(for ids: [String]) -> [String: Int] {
        Dictionary(uniqueKeysWithValues: state.lamps
            .filter { ids.contains($0.entityId) }
            .map { ($0.entityId, $0.brightness ?? 60) })
    }

    /// ±10% brightness. A thumb cannot place a slider to the percent, and most
    /// corrections are "a bit less than that" rather than a specific number.
    public func nudgeBrightness(_ delta: Int, on lamps: [Lamp]) async {
        let live = lamps.compactMap { l in state.lamps.first { $0.entityId == l.entityId } }
            .filter(\.reachable)
        guard !live.isEmpty else { return }
        var groups: [Int: [String]] = [:]
        for lamp in live {
            let value = max(1, min(100, (lamp.brightness ?? 60) + delta))
            groups[value, default: []].append(lamp.entityId)
        }
        Haptics.tap()
        for (value, ids) in groups {
            apply({ $0 = withBrightness($0, value) }, to: Set(ids))
            await send { try await self.client.setLights(ids, on: true, brightness: value) }
        }
    }

    /// ±200 K, clamped per bulb to its own reported envelope.
    public func nudgeKelvin(_ delta: Int, on lamps: [Lamp]) async {
        let live = lamps.compactMap { l in state.lamps.first { $0.entityId == l.entityId } }
            .filter(\.reachable)
        guard !live.isEmpty else { return }
        var groups: [Int: [String]] = [:]
        for lamp in live {
            let base = lamp.kelvin ?? 2700
            let value = max(lamp.minKelvin, min(lamp.maxKelvin, base + delta))
            groups[value, default: []].append(lamp.entityId)
        }
        Haptics.tap()
        for (value, ids) in groups {
            apply({ $0 = withKelvin($0, value) }, to: Set(ids))
            await send { try await self.client.setLights(ids, on: true, kelvin: value) }
        }
    }

    // MARK: - Scene preview

    /// Hold a scene to see it, release to put the room back.
    ///
    /// Built on the undo snapshot rather than on a new server route: capture,
    /// activate, and restore exactly what was there. That keeps it inside the
    /// routes that already exist, and it is the same code path the user can
    /// reach by hand afterwards.
    @ObservationIgnored private var preview: [Lamp]?

    public func beginPreview(_ scene: LightScene) async {
        guard preview == nil else { return }
        preview = state.reachable
        do {
            _ = try await client.activate(scene: scene.entityId)
            Haptics.tap()
        } catch {
            preview = nil
            flash((error as? VueError)?.errorDescription ?? "Couldn't preview that")
            return
        }
        await refresh()
    }

    /// `keep: true` when the press became a real activation.
    public func endPreview(keep: Bool) async {
        guard let before = preview else { return }
        preview = nil
        guard !keep else { return }
        await push(before.map { ($0, LampSetting($0)) })
        await refresh()
    }

    // MARK: - Plumbing

    /// Send a batch of exact per-lamp settings, coalescing identical ones.
    ///
    /// Four bulbs that all want the same thing are one request, not four —
    /// sequential round trips over this path are visibly staggered and the
    /// lamps change one at a time like a wave, which reads as the app being
    /// slow rather than as the mesh being serial.
    private func push(_ pairs: [(Lamp, LampSetting)]) async {
        var groups: [LampSetting: [String]] = [:]
        for (lamp, setting) in pairs {
            groups[setting, default: []].append(lamp.entityId)
        }
        for (setting, ids) in groups {
            await send {
                try await self.client.setLights(
                    ids, on: setting.on, brightness: setting.brightness,
                    kelvin: setting.kelvin, hs: setting.hs)
            }
        }
    }

    private func send(_ work: @escaping () async throws -> Void) async {
        do { try await work() } catch {
            flash((error as? VueError)?.errorDescription ?? "That didn't go through")
            await refresh()
        }
    }

    public func flash(_ message: String) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3.5))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }
}

// Small rebuilders. `Lamp` is a `let`-only struct so that nothing mutates house
// state by accident; these are the only sanctioned way to make a changed copy.
private func withOn(_ l: Lamp, _ on: Bool) -> Lamp {
    Lamp(entityId: l.entityId, name: l.name, reachable: l.reachable, on: on,
         brightness: on ? (l.brightness ?? 60) : nil, kelvin: l.kelvin,
         minKelvin: l.minKelvin, maxKelvin: l.maxKelvin, rgb: l.rgb, hs: l.hs,
         supportsColor: l.supportsColor, colorMode: l.colorMode)
}

private func withBrightness(_ l: Lamp, _ value: Int) -> Lamp {
    Lamp(entityId: l.entityId, name: l.name, reachable: l.reachable, on: true,
         brightness: max(1, min(100, value)), kelvin: l.kelvin,
         minKelvin: l.minKelvin, maxKelvin: l.maxKelvin, rgb: l.rgb, hs: l.hs,
         supportsColor: l.supportsColor, colorMode: l.colorMode)
}

private func withKelvin(_ l: Lamp, _ value: Int) -> Lamp {
    Lamp(entityId: l.entityId, name: l.name, reachable: l.reachable, on: true,
         brightness: l.brightness ?? 60, kelvin: max(l.minKelvin, min(l.maxKelvin, value)),
         minKelvin: l.minKelvin, maxKelvin: l.maxKelvin, rgb: nil, hs: nil,
         supportsColor: l.supportsColor, colorMode: "color_temp")
}

/// Paint a copied setting onto a lamp locally.
///
/// Takes the target's identity and capabilities and the source's look — never
/// the source's `entityId`, `name` or reachability, which is the bug that makes
/// a copy look like it duplicated the lamp.
private func applying(_ setting: AppModel.LampSetting, to l: Lamp) -> Lamp {
    guard setting.on else { return withOn(l, false) }
    return Lamp(
        entityId: l.entityId, name: l.name, reachable: l.reachable, on: true,
        brightness: setting.brightness ?? l.brightness ?? 60,
        kelvin: setting.kelvin,
        minKelvin: l.minKelvin, maxKelvin: l.maxKelvin, rgb: nil, hs: setting.hs,
        supportsColor: l.supportsColor,
        colorMode: setting.hs != nil ? "hs" : "color_temp")
}

private func withHS(_ l: Lamp, hue: Double, saturation: Double) -> Lamp {
    Lamp(entityId: l.entityId, name: l.name, reachable: l.reachable, on: true,
         brightness: l.brightness ?? 60, kelvin: nil,
         minKelvin: l.minKelvin, maxKelvin: l.maxKelvin, rgb: nil,
         hs: [hue, saturation], supportsColor: l.supportsColor, colorMode: "hs")
}
