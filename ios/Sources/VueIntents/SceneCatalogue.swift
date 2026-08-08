import Foundation
import VueCore

/// The scene list, mirrored to disk.
///
/// This exists because of one hard constraint: **`suggestedEntities()` must
/// never touch the network.** The system calls it opportunistically — while the
/// app is not running, sometimes offline, sometimes inside a window measured in
/// milliseconds — and a network call there is exactly how Siri comes to work on
/// Tuesday and not on Wednesday, with nothing in any log to explain it.
///
/// So the app writes this file whenever it learns something, and the entity
/// query only ever reads it. The file is the contract between a live app and a
/// Siri request that arrives when there is no app.
public struct SceneCatalogueEntry: Codable, Sendable, Hashable, Identifiable {
    public let entityId: String
    public let label: String
    /// Extra names the user typed. This array is the entire no-code feature: it
    /// becomes `alternativeNames` on the entity, which is what Siri matches.
    public let aliases: [String]
    public let symbol: String

    public var id: String { entityId }

    public init(entityId: String, label: String, aliases: [String] = [], symbol: String = "lightbulb.fill") {
        self.entityId = entityId
        self.label = label
        self.aliases = aliases
        self.symbol = symbol
    }
}

public struct SceneCatalogue: Codable, Sendable {
    public var scenes: [SceneCatalogueEntry]
    public var updatedAt: Date

    public init(scenes: [SceneCatalogueEntry], updatedAt: Date = .now) {
        self.scenes = scenes
        self.updatedAt = updatedAt
    }

    public static let empty = SceneCatalogue(scenes: [], updatedAt: .distantPast)
}

/// Reads and writes the mirror. Not an actor: every operation is a single
/// atomic file read or write, and making it one would force `await` into
/// `suggestedEntities()`, which is the call that most needs to be cheap.
public enum SceneCatalogueStore {
    private static let filename = "siri-scenes.json"

    private static var url: URL? {
        guard let dir = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true) else { return nil }
        return dir.appendingPathComponent(filename)
    }

    public static func load() -> SceneCatalogue {
        guard let url, let data = try? Data(contentsOf: url),
              let catalogue = try? JSONDecoder().decode(SceneCatalogue.self, from: data)
        else { return .empty }
        return catalogue
    }

    /// Every failure degrades to "Siri has an older list", never to a crash.
    public static func save(_ catalogue: SceneCatalogue) {
        guard let url, let data = try? JSONEncoder().encode(catalogue) else { return }
        // Atomic, so a Siri request landing mid-write reads the whole previous
        // file rather than a truncated one.
        try? data.write(to: url, options: .atomic)
    }

    /// Fold a fresh `/api/state` into the mirror, preserving the aliases and
    /// symbols the user set — those live here and in Postgres, not in Home
    /// Assistant, so a state refresh must not erase them.
    public static func merge(scenes: [LightScene]) -> SceneCatalogue {
        let existing = Dictionary(
            uniqueKeysWithValues: load().scenes.map { ($0.entityId, $0) })
        let merged = scenes.map { scene in
            SceneCatalogueEntry(
                entityId: scene.entityId,
                label: scene.label,
                aliases: existing[scene.entityId]?.aliases ?? [],
                symbol: existing[scene.entityId]?.symbol ?? Self.defaultSymbol(for: scene.label))
        }
        let catalogue = SceneCatalogue(scenes: merged)
        save(catalogue)
        return catalogue
    }

    public static func setAliases(_ aliases: [String], for entityId: String) {
        var catalogue = load()
        guard let i = catalogue.scenes.firstIndex(where: { $0.entityId == entityId }) else { return }
        let old = catalogue.scenes[i]
        catalogue.scenes[i] = SceneCatalogueEntry(
            entityId: old.entityId, label: old.label,
            aliases: aliases, symbol: old.symbol)
        catalogue.updatedAt = .now
        save(catalogue)
    }

    /// A reasonable glyph from the name, so a new scene is not a generic bulb.
    /// Guessed, and overridable — the point is that the default is rarely wrong
    /// enough to bother changing.
    static func defaultSymbol(for label: String) -> String {
        let name = label.lowercased()
        return switch true {
        case name.contains("movie"), name.contains("cinema"), name.contains("film"):
            "film.fill"
        case name.contains("late"), name.contains("night"), name.contains("sleep"):
            "moon.stars.fill"
        case name.contains("read"), name.contains("focus"), name.contains("work"):
            "book.fill"
        case name.contains("host"), name.contains("party"), name.contains("guest"):
            "wineglass.fill"
        case name.contains("guitar"), name.contains("music"), name.contains("practice"):
            "guitars.fill"
        case name.contains("bright"), name.contains("clean"), name.contains("all"):
            "sun.max.fill"
        case name.contains("evening"), name.contains("sunset"), name.contains("dusk"):
            "sunset.fill"
        default:
            "lightbulb.fill"
        }
    }
}
