import Foundation
import VueCore

/// The last reading the app took, written where the widget can see it.
///
/// This is a **cache of device state**, which the repo's third invariant says
/// must never be rendered as current — a stale reading is worse than an error
/// because the user acts on it. A widget cannot re-read the house on every
/// timeline refresh, so the honest arrangement is: keep the timestamp, and make
/// every caller go through `freshness` to find out what it is allowed to say.
public struct RoomSnapshot: Codable, Sendable, Hashable {
    public let lampsOn: Int
    public let lampsTotal: Int
    public let unreachable: Int
    public let averageBrightness: Int
    public let capturedAt: Date

    public init(
        lampsOn: Int, lampsTotal: Int, unreachable: Int,
        averageBrightness: Int, capturedAt: Date = .now
    ) {
        self.lampsOn = lampsOn
        self.lampsTotal = lampsTotal
        self.unreachable = unreachable
        self.averageBrightness = averageBrightness
        self.capturedAt = capturedAt
    }

    public init(_ state: HouseState, at date: Date = .now) {
        self.init(
            lampsOn: state.lamps.filter(\.on).count,
            lampsTotal: state.lamps.count,
            unreachable: state.lamps.filter { !$0.reachable }.count,
            averageBrightness: state.averageBrightness,
            capturedAt: date)
    }

    /// How much of the reading a surface is entitled to show.
    public enum Freshness: Sendable, Equatable {
        /// Taken moments ago. Safe to state plainly.
        case current
        /// Old enough that it has to be labelled with its age.
        case dated(String)
        /// Too old to be worth anything. Show nothing rather than a number.
        case expired
    }

    /// Under a minute is "now" — the app polls every five seconds while it is
    /// open, so anything under a minute was almost certainly written by a live
    /// session. Past an hour the reading is dropped entirely: a widget saying
    /// "2 of 4 on" about last night is the exact failure the invariant names.
    public func freshness(now: Date = .now) -> Freshness {
        let age = now.timeIntervalSince(capturedAt)
        switch age {
        case ..<60: return .current
        case ..<3600: return .dated(Self.ageLabel(age))
        default: return .expired
        }
    }

    static func ageLabel(_ age: TimeInterval) -> String {
        let minutes = max(1, Int(age / 60))
        return "\(minutes) min ago"
    }

    /// The one line a widget may print, already qualified by its own age.
    /// Nil means "say nothing" — which is a legitimate answer here.
    public func statusLine(now: Date = .now) -> String? {
        guard lampsTotal > 0 else { return nil }
        let body = lampsOn == 0 ? "All off" : "\(lampsOn) of \(lampsTotal) on"
        switch freshness(now: now) {
        case .current: return unreachable > 0 ? "\(body) · \(unreachable) unreachable" : body
        case let .dated(age): return "\(body) · \(age)"
        case .expired: return nil
        }
    }
}

public enum RoomSnapshotStore {
    private static let filename = "room-snapshot.json"

    public static func load() -> RoomSnapshot? {
        VueShared.read(RoomSnapshot.self, from: filename)
    }

    public static func save(_ snapshot: RoomSnapshot) {
        VueShared.write(snapshot, to: filename)
    }
}
