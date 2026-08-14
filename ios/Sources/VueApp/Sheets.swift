import SwiftUI
import VueCore
import VueDesignSystem
import VueIntents

// MARK: - One lamp, in detail

struct LampDetailSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let lamp: Lamp

    @State private var brightness: Double
    @State private var kelvin: Double
    @State private var hue: Double
    @State private var saturation: Double
    @State private var mode: Mode

    enum Mode: String, CaseIterable { case white = "White", colour = "Colour" }

    init(lamp: Lamp) {
        self.lamp = lamp
        _brightness = State(initialValue: Double(lamp.brightness ?? 60))
        _kelvin = State(initialValue: Double(lamp.kelvin ?? 2700))
        _hue = State(initialValue: lamp.hs?.first ?? 30)
        _saturation = State(initialValue: lamp.hs?.last ?? 70)
        _mode = State(initialValue: lamp.colorMode == "color_temp" ? .white : .colour)
    }

    /// The live lamp, not the one captured when the sheet opened — a scene fired
    /// from Siri while this is open should be visible here too.
    private var current: Lamp {
        model.state.lamps.first { $0.entityId == lamp.entityId } ?? lamp
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.space5) {
                    preview

                    labelled("Brightness", "\(Int(brightness))%") {
                        Slider(value: $brightness, in: 1...100) { editing in
                            commit(editing: editing) {
                                await model.setBrightness(Int(brightness), on: [lamp.entityId], commit: true)
                            }
                        }
                        .tint(Palette.accent)
                    }

                    if current.supportsColor {
                        Picker("Mode", selection: $mode) {
                            ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }

                    if mode == .white || !current.supportsColor {
                        labelled("Warmth", "\(Int(kelvin))K") {
                            Slider(value: $kelvin,
                                   in: Double(current.minKelvin)...Double(current.maxKelvin)) { editing in
                                commit(editing: editing) {
                                    await model.setKelvin(Int(kelvin), on: [lamp.entityId], commit: true)
                                }
                            }
                            .tint(Color(LightColor.rgb(kelvin: Int(kelvin))))
                            .background(
                                Gradients.temperature
                                    .frame(height: 4)
                                    .clipShape(Capsule())
                                    .allowsHitTesting(false))
                        }
                    } else {
                        labelled("Hue", "\(Int(hue))°") {
                            Slider(value: $hue, in: 0...360) { editing in
                                commit(editing: editing) {
                                    await model.setColor(hue: hue, saturation: saturation,
                                                         on: [lamp.entityId], commit: true)
                                }
                            }
                            .tint(Color(LightColor.rgb(hue: hue, saturation: 100)))
                        }
                        labelled("Saturation", "\(Int(saturation))%") {
                            Slider(value: $saturation, in: 0...100) { editing in
                                commit(editing: editing) {
                                    await model.setColor(hue: hue, saturation: saturation,
                                                         on: [lamp.entityId], commit: true)
                                }
                            }
                            .tint(Color(LightColor.rgb(hue: hue, saturation: saturation)))
                        }
                    }

                    nudges
                    copyTargets

                    Button {
                        Task { await model.toggle(current); dismiss() }
                    } label: {
                        Label(current.on ? "Turn off" : "Turn on",
                              systemImage: current.on ? "power" : "lightbulb.fill")
                            .frame(maxWidth: .infinity)
                            .frame(height: Metrics.minimumTapTarget)
                            .background(Palette.neutralSurface,
                                        in: RoundedRectangle(cornerRadius: Metrics.radiusMD))
                            .foregroundStyle(Palette.inkSecondary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(Metrics.pagePadding)
            }
            .background(Palette.background)
            .navigationTitle(current.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Palette.background)
    }

    /// Coarse steps, for the correction a slider cannot make.
    ///
    /// "A bit dimmer" is the most common adjustment there is, and it is
    /// precisely the one a thumb on a 300pt slider cannot make repeatably — the
    /// finger covers the value it is trying to read. A pair of buttons is
    /// exact, repeatable, and works without looking.
    private var nudges: some View {
        VStack(alignment: .leading, spacing: Metrics.space2) {
            nudgeRow("Brightness", minus: "−10%", plus: "+10%") { delta in
                await model.nudgeBrightness(delta * 10, on: [current])
                brightness = Double(model.state.lamps
                    .first { $0.entityId == lamp.entityId }?.brightness ?? Int(brightness))
            }
            nudgeRow("Warmth", minus: "Warmer", plus: "Cooler") { delta in
                await model.nudgeKelvin(delta * 200, on: [current])
                kelvin = Double(model.state.lamps
                    .first { $0.entityId == lamp.entityId }?.kelvin ?? Int(kelvin))
            }
        }
    }

    private func nudgeRow(
        _ title: String, minus: String, plus: String,
        _ action: @escaping (Int) async -> Void
    ) -> some View {
        HStack(spacing: Metrics.space2) {
            Text(title)
                .font(.system(size: 12))
                .foregroundStyle(Palette.inkSecondary)
                .frame(width: 74, alignment: .leading)
            ForEach([(-1, minus), (1, plus)], id: \.1) { delta, label in
                Button { Task { await action(delta) } } label: {
                    Text(label)
                        .font(.system(size: 13, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .frame(height: Metrics.minimumTapTarget)
                        .background(Palette.neutralSurface,
                                    in: RoundedRectangle(cornerRadius: Metrics.radiusMD))
                        .foregroundStyle(Palette.inkSecondary)
                }
                .buttonStyle(.plain)
            }
        }
        .disabled(!current.reachable)
    }

    /// "Make that one look like this one."
    ///
    /// The map has a drag gesture for this, which is faster once you know it
    /// exists. This is the discoverable version, and the only version under
    /// VoiceOver — you cannot drag a dot onto another dot with a screen reader.
    @ViewBuilder
    private var copyTargets: some View {
        let others = model.state.reachable.filter { $0.entityId != lamp.entityId }
        if !others.isEmpty {
            VStack(alignment: .leading, spacing: Metrics.space2) {
                Text("COPY THIS LOOK TO")
                    .font(.system(size: 11, weight: .medium))
                    .tracking(0.6)
                    .foregroundStyle(Palette.inkMuted)

                ScrollView(.horizontal) {
                    HStack(spacing: Metrics.space2) {
                        ForEach(others) { other in
                            copyChip(other.name) {
                                await model.copySettings(from: current, to: [other])
                            }
                        }
                        if others.count > 1 {
                            copyChip("Every lamp", emphasised: true) {
                                await model.matchAll(to: current)
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
        }
    }

    private func copyChip(
        _ title: String, emphasised: Bool = false, _ action: @escaping () async -> Void
    ) -> some View {
        Button {
            Task { await action(); dismiss() }
        } label: {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .padding(.horizontal, Metrics.space3)
                .frame(height: 38)
                .background(emphasised ? Palette.accentSubtle : Palette.neutralSurface,
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    emphasised ? Palette.accentBorder : Palette.border))
                .foregroundStyle(emphasised ? Palette.accent : Palette.inkSecondary)
        }
        .buttonStyle(.plain)
        .disabled(!current.reachable)
    }

    private var preview: some View {
        RoundedRectangle(cornerRadius: Metrics.radiusLG)
            .fill(RadialGradient(
                colors: [previewColour.opacity(brightness / 100), Palette.surface],
                center: .center, startRadius: 4, endRadius: 140))
            .frame(height: 96)
            .overlay {
                RoundedRectangle(cornerRadius: Metrics.radiusLG).strokeBorder(Palette.border)
            }
            .accessibilityHidden(true)
    }

    private var previewColour: Color {
        mode == .white || !current.supportsColor
            ? Color(LightColor.rgb(kelvin: Int(kelvin)))
            : Color(LightColor.rgb(hue: hue, saturation: saturation))
    }

    private func commit(editing: Bool, _ work: @escaping () async -> Void) {
        if editing {
            model.beginGesture(on: [lamp.entityId])
        } else {
            Task {
                await work()
                model.endGesture(on: [lamp.entityId])
            }
        }
    }

    @ViewBuilder
    private func labelled(
        _ title: String, _ value: String, @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: Metrics.space1) {
            HStack {
                Text(title).font(.system(size: 12)).foregroundStyle(Palette.inkSecondary)
                Spacer()
                Text(value)
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(Palette.inkMuted)
            }
            content()
        }
    }
}

// MARK: - What Siri hears

/// The whole no-code Siri feature, as a text field.
///
/// Siri will not take a free-form phrase, but it will match an entity against
/// its title AND its synonyms — and synonyms are just an array of strings on the
/// entity's display representation. So typing "movie time" here genuinely
/// creates a spoken command, with no Xcode, no Shortcuts app and no rebuild.
struct SceneEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let scene: LightScene

    @State private var aliases: [String] = []
    @State private var draft = ""
    @State private var confirmingDelete = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(phrases, id: \.self) { phrase in
                        Label("“\(phrase)”", systemImage: "quote.bubble")
                            .font(.system(size: 14))
                            .foregroundStyle(Palette.inkSecondary)
                    }
                } header: {
                    Text("What Siri hears")
                } footer: {
                    // An invisible feature is an unused one. Showing the literal
                    // phrases is what makes the field below obviously worth
                    // filling in.
                    Text("Every phrase has to include the app's name — that's an Apple requirement, not a choice. Siri also answers to “Vue”, “Lights” and “Living Room”.")
                }

                Section {
                    ForEach(aliases, id: \.self) { alias in
                        Text(alias)
                    }
                    .onDelete { offsets in
                        aliases.remove(atOffsets: offsets)
                        save()
                    }
                    HStack {
                        TextField("e.g. movie time", text: $draft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit(add)
                        Button("Add", action: add)
                            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                } header: {
                    Text("Also call it")
                } footer: {
                    Text("Each name becomes its own Siri phrase. “\(scene.label)” already works — these are for the words you'd actually say.")
                }

                Section {
                    Button("Delete scene", role: .destructive) { confirmingDelete = true }
                        .disabled(scene.id == nil)
                } footer: {
                    if scene.id == nil {
                        Text("This scene wasn't created here, so it can only be removed in Home Assistant.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            .navigationTitle(scene.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Delete “\(scene.label)”?", isPresented: $confirmingDelete,
                                titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task { await model.deleteScene(scene); dismiss() }
                }
            } message: {
                Text("This removes it from Home Assistant too.")
            }
        }
        .onAppear { aliases = model.aliases(for: scene) }
        .presentationDetents([.large])
        .presentationBackground(Palette.background)
    }

    /// Exactly the phrases `VueShortcuts` generates for this scene.
    ///
    /// Each name — the label and every alias — expands into one phrase per
    /// template, which is how the 1,000-phrase ceiling is counted. At three
    /// templates, a scene with four aliases is fifteen phrases on its own.
    private var phrases: [String] {
        ([scene.label] + aliases).flatMap(ScenePhrasing.spoken(for:))
    }

    private func add() {
        let value = draft.trimmingCharacters(in: .whitespaces).lowercased()
        draft = ""
        guard !value.isEmpty, !aliases.contains(value) else { return }
        aliases.append(value)
        save()
    }

    private func save() {
        Task { await model.setAliases(aliases, for: scene) }
    }
}

// MARK: - Settings

struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("vue.useList") private var preferList = false
    @State private var url = ""

    var body: some View {
        @Bindable var model = model

        NavigationStack {
            List {
                Section {
                    Toggle("Use a list instead of the room map", isOn: $preferList)
                } footer: {
                    Text("The map is turned off automatically when VoiceOver is on.")
                }

                Section {
                    TextField("https://…", text: $url)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .onSubmit { model.baseURL = url }
                } header: {
                    Text("Server")
                } footer: {
                    Text("The app never talks to Home Assistant directly — it can't, and the token that would let it is worth more than this app is.")
                }

                Section("Lamps") {
                    ForEach(model.state.lamps) { lamp in
                        HStack {
                            Text(lamp.name)
                            Spacer()
                            Text(lamp.reachable ? "OK" : "Unreachable")
                                .font(.system(size: 13))
                                .foregroundStyle(lamp.reachable ? Palette.positive : Palette.warning)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
        .onAppear { url = model.baseURL }
        .presentationBackground(Palette.background)
    }
}
