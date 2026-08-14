import AppIntents
import SwiftUI
import VueDesignSystem
import VueIntents
import WidgetKit

// MARK: - Timeline

struct SceneEntry: TimelineEntry {
    let date: Date
    let scenes: [SceneCatalogueEntry]
    let snapshot: RoomSnapshot?

    static let placeholder = SceneEntry(
        date: .now,
        scenes: [
            SceneCatalogueEntry(entityId: "scene.a", label: "Evening", symbol: "sunset.fill"),
            SceneCatalogueEntry(entityId: "scene.b", label: "Movie", symbol: "film.fill"),
            SceneCatalogueEntry(entityId: "scene.c", label: "Focus", symbol: "book.fill"),
            SceneCatalogueEntry(entityId: "scene.d", label: "Late", symbol: "moon.stars.fill"),
        ],
        snapshot: nil)
}

/// Reads the App Group mirror, and nothing else.
///
/// **No network call belongs here.** The system rebuilds a timeline on its own
/// schedule — often with nothing on screen, often with the phone asleep — and a
/// widget that makes a request per refresh spends the user's battery answering a
/// question nobody asked, then gets its refresh budget cut for doing it. The app
/// writes the mirror on every foreground poll; this reads it.
struct SceneTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> SceneEntry { .placeholder }

    func getSnapshot(in context: Context, completion: @escaping (SceneEntry) -> Void) {
        // The gallery preview. Real scenes if the app has ever run, invented
        // ones if it has not — an empty widget in the gallery tells the user
        // nothing about what the widget is for.
        let scenes = SceneCatalogueStore.load().scenes
        completion(scenes.isEmpty
            ? .placeholder
            : SceneEntry(date: .now, scenes: scenes, snapshot: RoomSnapshotStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SceneEntry>) -> Void) {
        let entry = SceneEntry(
            date: .now,
            scenes: SceneCatalogueStore.load().scenes,
            snapshot: RoomSnapshotStore.load())
        // Fifteen minutes, not because the scenes change that often — the app
        // reloads this timeline the moment they do — but because the status line
        // carries its own age, and an age that stops counting is a lie with a
        // timestamp on it.
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
    }
}

// MARK: - The widget

struct SceneGridWidget: Widget {
    static let kind = "me.renatodap.vuelights.widget.scenes"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: SceneTimelineProvider()) { entry in
            SceneGridView(entry: entry)
                .containerBackground(Palette.background, for: .widget)
        }
        .configurationDisplayName("Scenes")
        .description("Your lighting scenes, one tap from the Home Screen.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct SceneGridView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SceneEntry

    /// Small holds four; medium holds eight without the labels getting tight.
    private var capacity: Int { family == .systemSmall ? 4 : 8 }
    private var columns: Int { family == .systemSmall ? 2 : 4 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if entry.scenes.isEmpty {
                empty
            } else {
                grid
            }
        }
    }

    private var header: some View {
        HStack(spacing: 4) {
            Text("Living Room")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.inkPrimary)
            Spacer(minLength: 0)
            // Nil when the cached reading is too old to be worth printing. An
            // absent status line is the honest rendering of "I don't know" —
            // the alternative is a widget confidently describing last night.
            if let status = entry.snapshot?.statusLine() {
                Text(status)
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.inkMuted)
                    .lineLimit(1)
            }
        }
    }

    private var grid: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: columns),
            spacing: 6
        ) {
            ForEach(entry.scenes.prefix(capacity)) { scene in
                SceneButton(scene: scene)
            }
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 4) {
            Spacer(minLength: 0)
            Text("No scenes yet")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.inkSecondary)
            // Says what to do rather than what went wrong. The widget cannot
            // fetch the list itself by design, so opening the app once is
            // genuinely the fix and not a shrug.
            Text("Open Vue Lights once and they'll appear here.")
                .font(.system(size: 11))
                .foregroundStyle(Palette.inkMuted)
            Spacer(minLength: 0)
        }
        .widgetURL(URL(string: "vuelights://"))
    }
}

/// One tappable scene.
///
/// `Button(intent:)` is the entire interactive-widget vocabulary — that and
/// `Toggle`, and only via App Intents. The intent is the same
/// `ActivateSceneIntent` Siri runs, which is the point of the whole arrangement.
///
/// On iOS 26 the system performs this in the **widget extension's** process, so
/// the HTTP write happens here rather than in the app. That works — the
/// extension links `VueIntents` and reads the server URL and token out of the
/// App Group — and it is why the shared defaults suite is load-bearing rather
/// than tidy. iOS 27's `ExecutionTargets` would let us pin it to `.main`
/// instead; the two protocols that force app-process execution today
/// (`AudioPlaybackIntent`, `LiveActivityIntent`) both promise the system
/// something a light switch does not deliver, so neither is honest here.
struct SceneButton: View {
    let scene: SceneCatalogueEntry

    var body: some View {
        Button(intent: ActivateSceneIntent(scene: SceneEntity(scene))) {
            VStack(spacing: 2) {
                Image(systemName: scene.symbol)
                    .font(.system(size: 14))
                    .foregroundStyle(Palette.accent)
                Text(scene.label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Palette.inkSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.radiusMD))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.radiusMD)
                    .strokeBorder(Palette.border))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(scene.label)
        .accessibilityHint("Applies this scene")
    }
}
