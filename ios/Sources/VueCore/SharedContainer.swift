import Foundation

/// The container the app and its extensions both see.
///
/// This exists because a widget extension is a **different process with a
/// different sandbox**. `UserDefaults.standard` in the widget is not the app's
/// `UserDefaults.standard`, and `.applicationSupportDirectory` in the widget is
/// not the app's Application Support. Nothing warns about this: reads simply
/// return nil, so the symptom is a widget that renders its empty state forever
/// while the app right next to it is full of data.
///
/// Every piece of state that has to cross that boundary — the server URL, the
/// bearer token, the Siri scene mirror, the last room reading — goes through
/// here.
public enum VueShared {
    /// Must match the `com.apple.security.application-groups` entitlement on
    /// **both** targets in `project.yml`. A mismatch is not a build error; the
    /// container URL just comes back nil and everything silently falls back to
    /// per-process storage.
    public static let appGroup = "group.me.renatodap.vuelights"

    /// Falls back to `.standard` rather than returning nil.
    ///
    /// The fallback is what keeps `swift test` and any build without the
    /// entitlement working: the app is then merely not sharing with anything,
    /// which is exactly the behaviour it had before the group existed.
    public static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    /// Nil when the entitlement is missing — on macOS test hosts, and on any
    /// build where provisioning did not grant the group.
    public static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    /// The shared location for a file, or the per-process one if there is no
    /// shared container.
    public static func url(for filename: String) -> URL? {
        container?.appendingPathComponent(filename) ?? processURL(for: filename)
    }

    /// Where these files lived before the App Group existed. Still read once,
    /// so an upgrade does not lose the aliases the user typed.
    static func processURL(for filename: String) -> URL? {
        guard let dir = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true) else { return nil }
        return dir.appendingPathComponent(filename)
    }

    // MARK: - Small atomic JSON files

    /// Reads, migrating a pre-App-Group file into the shared container the first
    /// time it is asked for.
    public static func read<T: Decodable>(_ type: T.Type, from filename: String) -> T? {
        guard let url = url(for: filename) else { return nil }
        if !FileManager.default.fileExists(atPath: url.path),
           let legacy = processURL(for: filename), legacy != url,
           let data = try? Data(contentsOf: legacy) {
            try? data.write(to: url, options: .atomic)
        }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    /// Best-effort, and deliberately so. Every failure here degrades to "the
    /// widget shows an older list", never to a thrown error in a code path the
    /// user is watching a lamp for.
    public static func write<T: Encodable>(_ value: T, to filename: String) {
        guard let url = url(for: filename), let data = try? JSONEncoder().encode(value) else { return }
        // Atomic, so a widget timeline landing mid-write reads the whole
        // previous file rather than a truncated one.
        try? data.write(to: url, options: .atomic)
    }
}

/// The two settings an extension needs to talk to the server.
///
/// Written to the shared suite **and** to `.standard`. The double write is the
/// migration: an install that already stored a custom URL under
/// `UserDefaults.standard` keeps working, and the first save copies it across
/// with no separate migration step to forget.
public enum VueSettings {
    private static let baseURLKey = "vue.baseURL"
    private static let tokenKey = "vue.token"

    public static var baseURL: String? {
        get {
            VueShared.defaults.string(forKey: baseURLKey)
                ?? UserDefaults.standard.string(forKey: baseURLKey)
        }
        set {
            VueShared.defaults.set(newValue, forKey: baseURLKey)
            UserDefaults.standard.set(newValue, forKey: baseURLKey)
        }
    }

    public static var token: String? {
        get {
            VueShared.defaults.string(forKey: tokenKey)
                ?? UserDefaults.standard.string(forKey: tokenKey)
        }
        set {
            VueShared.defaults.set(newValue, forKey: tokenKey)
            UserDefaults.standard.set(newValue, forKey: tokenKey)
        }
    }
}
