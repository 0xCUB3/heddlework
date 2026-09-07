import SwiftUI

// First-run screen: paste the connect link that `bun run host` prints, or scan its QR code.
struct ConnectView: View {
    var embedded = false
    var onConnected: (() -> Void)?
    @EnvironmentObject private var store: SavedHostsStore
    @State private var text = ""
    @State private var error: String?
    @State private var scanning = false

    var body: some View {
        Group {
            if embedded {
                form
                    .navigationTitle("Add computer")
                    .navigationBarTitleDisplayMode(.inline)
            } else {
                NavigationStack {
                    form
                        .navigationTitle("Heddlework")
                }
            }
        }
    }

    private var form: some View {
        Form {
            Section {
                Text("Run `bun run host` on your Mac with HEDDLEWORK_HOST_BIND=0.0.0.0, then paste the connect link it prints or scan its QR code.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("Connect link") {
                TextField("Connect link", text: $text, prompt: Text("http://192.168.1.20:47311/?token=…"))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .accessibilityIdentifier("connect-link")
                    .accessibilityLabel("connect-link")
                    .onSubmit(submit)
                if let error {
                    Text(error).foregroundStyle(.red).font(.footnote)
                }
                Button("Connect", action: submit)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("connect-submit")
                Button("Scan QR code") { scanning = true }
                    .accessibilityIdentifier("connect-scan-qr")
            }
            if !embedded, !store.hosts.isEmpty {
                Section("Saved computers") {
                    ForEach(store.hosts) { host in
                        Button {
                            store.select(id: host.id)
                            onConnected?()
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: host.machine.systemImage)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(host.name)
                                    Text(host.url.host ?? host.url.absoluteString)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .accessibilityIdentifier("connect-saved-\(host.id)")
                    }
                }
            }
        }
        .accessibilityIdentifier("connect-form")
        .sheet(isPresented: $scanning) {
            QRScannerView { value in
                scanning = false
                text = value
                submit()
            }
        }
    }

    private func submit() {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), let link = ConnectLink(url: url) else {
            error = "That is not a Heddlework connect link. It should look like http://host:port/?token=…"
            return
        }
        error = nil
        store.connect(link)
        onConnected?()
    }
}
