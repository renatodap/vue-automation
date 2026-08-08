import Foundation
import Observation
import SwiftUI
import VueCore
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

    public var baseURL: String {
        didSet {
            UserDefaults.standard.set(baseURL, forKey: "vue.baseURL")
            let url = URL(string: baseURL) ?? VueAPI.defaultBaseURL
            client = APIClient(baseURL: url)
            Task { await refresh() }
        }
    }

    public init() {
        let stored = UserDefaults.standard.string(forKey: "vue.baseURL")
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
            // Keep Siri's list current. Cheap, and the alternative is a scene
            // that exists in the app and not in Siri until the next launch.
            _ = SceneCatalogueStore.merge(scenes: fresh.scenes)
            await refreshShortcuts()
        } catch {
            let message = (error as? VueError)?.errorDescription ?? "Something went wrong."
            status = state.lamps.isEmpty ? .down(message) : .stale(message)
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
    func refreshShortcuts() async {
        VueShortcuts.updateAppShortcutParameters()
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
        guard lamp.reachable else { return }
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
        apply({ $0 = withOn($0, false) }, to: Set(ids))
        await send { try await self.client.setLights(ids, on: false) }
    }

    public func allOn() async {
        let ids = state.reachable.map(\.entityId)
        guard !ids.isEmpty else { return }
        let level = state.averageBrightness
        apply({ $0 = withBrightness(withOn($0, true), level) }, to: Set(ids))
        await send { try await self.client.setLights(ids, on: true, brightness: level) }
    }

    public func activate(_ scene: LightScene) async {
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
        await refreshShortcuts()
        flash(aliases.isEmpty ? "Cleared the extra names" : "Siri will listen for \(aliases.count) more")
    }

    public func aliases(for scene: LightScene) -> [String] {
        SceneCatalogueStore.load().scenes
            .first { $0.entityId == scene.entityId }?.aliases ?? []
    }

    // MARK: - Plumbing

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

private func withHS(_ l: Lamp, hue: Double, saturation: Double) -> Lamp {
    Lamp(entityId: l.entityId, name: l.name, reachable: l.reachable, on: true,
         brightness: l.brightness ?? 60, kelvin: nil,
         minKelvin: l.minKelvin, maxKelvin: l.maxKelvin, rgb: nil,
         hs: [hue, saturation], supportsColor: l.supportsColor, colorMode: "hs")
}
