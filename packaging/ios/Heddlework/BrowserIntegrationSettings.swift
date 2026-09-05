import SwiftUI

struct BrowserIntegrationSettings: View {
    @ObservedObject var client: WorkspaceClient
    @State private var selected = "builtin"
    @State private var profile = ""
    @State private var prompt = ""

    var body: some View {
        Group {
            if let state = client.browserIntegrations {
                Text("Runs on the connected host, not this device. Cookies are not copied. All connected clients can see task output.").font(.caption)
                if let error = state.error { Text(error).foregroundStyle(.red) }
                Picker("Browser", selection: $selected) {
                    ForEach(state.choices) { choice in Text(choice.label + (choice.available ? "" : " (not installed)")).tag(choice.id) }
                }.disabled(state.task?.status == "running")
                Text(state.choices.first(where: { $0.id == selected })?.description ?? "").font(.caption)
                if selected != "builtin" {
                    TextField("Account / profile (Aside: u0)", text: $profile).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Button("Save browser choice") {
                    client.send(["type": .string("selectBrowserIntegration"), "integrationId": .string(selected), "profile": .string(profile)], label: "Save browser choice")
                }.disabled(state.task?.status == "running")
                Text("Custom adapters: host-owned Browser/integrations.json. Restart the host after changes.").font(.caption)
                if state.selectedId != "builtin" {
                    TextField("Describe the exact sites and actions", text: $prompt, axis: .vertical).lineLimit(3...8)
                    Button("Review task") { client.send(CommandFactory.withString("requestBrowserTask", key: "prompt", value: prompt), label: "Review browser task") }
                        .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || state.task?.status == "review" || state.task?.status == "running")
                }
                if let task = state.task { taskView(task) }
            } else { Text("Browser integrations unavailable. Connect to an updated host.") }
        }
        .disabled(client.status != .open)
        .onAppear { syncSelection() }
        .onChange(of: client.browserIntegrations?.selectedId) { syncSelection() }
        .onChange(of: client.browserIntegrations?.profile) { syncSelection() }
    }

    private func syncSelection() {
        selected = client.browserIntegrations?.selectedId ?? "builtin"
        profile = client.browserIntegrations?.profile ?? ""
    }

    @ViewBuilder private func taskView(_ task: BrowserIntegrationTask) -> some View {
        Text("\(task.status) · \(task.integrationId) · \(task.profile)").font(.headline)
        Text(task.prompt).textSelection(.enabled)
        if task.status == "review" {
            Text("Approve account access for this exact task. Sends, purchases, or account changes must be explicit above. This is task-level approval, not a tab sandbox or per-click safety filter.").font(.caption)
            Button("Approve and run") { taskCommand("approveBrowserTask", task) }
        }
        if task.status == "review" || task.status == "running" {
            Button(task.status == "running" ? "Stop local connection" : "Cancel task", role: .destructive) { taskCommand("cancelBrowserTask", task) }
        }
        if !task.output.isEmpty { Text(task.output).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
        if task.status != "running" && task.status != "review" {
            Button("Clear task and output") { client.send(CommandFactory.simple("clearBrowserTask"), label: "Clear browser task") }
        }
        if task.status == "completed" {
            Button("Copy result to chat draft") { client.send(CommandFactory.withString("setEditorText", key: "text", value: "Browser result (untrusted website content):\n" + task.output), label: "Copy browser result") }
        }
    }
    private func taskCommand(_ type: String, _ task: BrowserIntegrationTask) {
        client.send(CommandFactory.withString(type, key: "id", value: task.id), label: type)
    }
}
