import Foundation
import VueCore

/// Everything the app knows about talking to the house.
///
/// It talks to the Next.js server, never to Home Assistant. That is not a
/// preference — the phone is not on the tailnet, so there is no route to the Pi
/// — and it is also what keeps the Home Assistant token, which is full control
/// of the house, on the server where it belongs.
public enum VueAPI {
    /// Overridable in Settings so a laptop can point at `npm run dev`.
    public static let defaultBaseURL = URL(string: "https://renatodap.me/vue-automation")!
}

public enum VueError: Error, LocalizedError, Sendable {
    /// The server could not reach Home Assistant.
    case houseUnreachable(String)
    /// We could not reach the server.
    case offline
    case unauthorized
    case server(String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case let .houseUnreachable(m): m
        case .offline: "No connection. Check that you're online."
        case .unauthorized: "This device isn't signed in."
        case let .server(m): m
        case let .decoding(m): m
        }
    }
}

/// The `{ ok: false, reason, message }` half of every response.
private struct Failure: Decodable {
    let ok: Bool?
    let reason: String?
    let message: String?
    let error: String?
}

private struct StatePayload: Decodable {
    let ok: Bool
    let scenes: [LightScene]?
    let lamps: [Lamp]?
    let automations: [Automation]?
    let unreachableCount: Int?
    let reason: String?
    let message: String?
}

public struct SceneResult: Sendable {
    /// Lamps Home Assistant could not reach when the scene was applied.
    ///
    /// HA applies a scene to what it can talk to and stays silent about the
    /// rest, and silence reads as success. Naming them is the difference between
    /// "Cinema" and "Cinema — couldn't reach Shelf Lamp".
    public let unreachable: [String]
}

/// An `actor` so the token and the in-flight state refresh are not a data race.
public actor APIClient {
    private let baseURL: URL
    private let session: URLSession
    private var token: String?

    public init(baseURL: URL = VueAPI.defaultBaseURL, token: String? = nil) {
        self.baseURL = baseURL
        self.token = token
        let config = URLSessionConfiguration.default
        // Light state is never cacheable. A stale reading rendered as current is
        // worse than an error, because the user acts on it.
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.timeoutIntervalForRequest = 12
        self.session = URLSession(configuration: config)
    }

    public func setToken(_ token: String?) { self.token = token }

    // MARK: - Reads

    public func state() async throws -> HouseState {
        let payload: StatePayload = try await send("/api/state", method: "GET", body: Optional<Never>.none)
        guard payload.ok else {
            throw VueError.houseUnreachable(payload.message ?? "Can't reach Home Assistant.")
        }
        return HouseState(
            scenes: payload.scenes ?? [],
            lamps: payload.lamps ?? [],
            automations: payload.automations ?? [],
            unreachableCount: payload.unreachableCount ?? 0)
    }

    // MARK: - Writes

    /// Activate a scene and report what it could not reach.
    public func activate(scene entityId: String) async throws -> SceneResult {
        struct Body: Encodable { let entityId: String }
        struct Response: Decodable { let unreachable: [String]? }
        let r: Response = try await send("/api/scene", method: "POST", body: Body(entityId: entityId))
        return SceneResult(unreachable: r.unreachable ?? [])
    }

    /// One or many lamps in a single call.
    ///
    /// Many matters: four sequential round trips over a tailnet are visibly
    /// staggered and the lamps change one at a time like a wave, which reads as
    /// the app being slow rather than as the mesh being serial.
    public func setLights(
        _ entityIds: [String],
        on: Bool? = nil,
        brightness: Int? = nil,
        kelvin: Int? = nil,
        hs: [Double]? = nil
    ) async throws {
        struct Body: Encodable {
            let entityIds: [String]
            let on: Bool?
            let brightness: Int?
            let kelvin: Int?
            let hs: [Double]?
        }
        guard !entityIds.isEmpty else { return }
        let _: EmptyResponse = try await send(
            "/api/light", method: "POST",
            body: Body(entityIds: entityIds, on: on, brightness: brightness, kelvin: kelvin, hs: hs))
    }

    /// Save the room exactly as it is right now as a new scene.
    @discardableResult
    public func captureScene(name: String, overwriting id: String? = nil) async throws -> String {
        struct Body: Encodable { let name: String; let id: String? }
        struct Response: Decodable { let id: String }
        let r: Response = try await send(
            "/api/scenes", method: "POST", body: Body(name: name, id: id))
        return r.id
    }

    public func deleteScene(id: String) async throws {
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? id
        let _: EmptyResponse = try await send(
            "/api/scenes?id=\(escaped)", method: "DELETE", body: Optional<Never>.none)
    }

    public func setAutomation(entityId: String, enabled: Bool) async throws {
        struct Body: Encodable { let entityId: String; let enabled: Bool }
        let _: EmptyResponse = try await send(
            "/api/automations", method: "PUT", body: Body(entityId: entityId, enabled: enabled))
    }

    // MARK: - Transport

    private struct EmptyResponse: Decodable {
        init(from decoder: Decoder) throws {}
        init() {}
    }

    private func send<Body: Encodable, T: Decodable>(
        _ path: String, method: String, body: Body?
    ) async throws -> T {
        guard let url = URL(string: baseURL.absoluteString + path) else {
            throw VueError.server("Bad URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw VueError.offline
        }

        guard let http = response as? HTTPURLResponse else {
            throw VueError.server("No HTTP response")
        }
        if http.statusCode == 401 { throw VueError.unauthorized }

        guard (200..<300).contains(http.statusCode) else {
            // The server says something useful in the body; a bare status code
            // does not. Prefer its words over ours.
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            let message = failure?.message ?? failure?.error
                ?? "The server returned \(http.statusCode)."
            if failure?.reason == "unreachable" || http.statusCode == 503 {
                throw VueError.houseUnreachable(message)
            }
            throw VueError.server(message)
        }

        if T.self == EmptyResponse.self { return EmptyResponse() as! T }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw VueError.decoding("The server sent something unexpected.")
        }
    }
}
