import SwiftUI
import UIKit

struct TerminalPanelView: View {
    @ObservedObject var client: WorkspaceClient
    var onClose: () -> Void
    @State private var cols = 80
    @State private var rows = 24
    @FocusState private var inputFocused: Bool

    private var snapshot: RemoteTerminalSnapshot? { client.terminal }
    private var session: RemoteTerminalSession? {
        let sessions = snapshot?.sessions ?? []
        if let active = snapshot?.activeId, let match = sessions.first(where: { $0.id == active }) { return match }
        return sessions.first
    }
    private var frame: RemoteTerminalFrame? {
        guard let id = session?.id else { return nil }
        return client.terminalFrames[id]
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "terminal").font(.workbench(size: 13)).foregroundStyle(AppColors.muted)
                Text(session?.title ?? session?.name ?? "Terminal")
                    .font(.workbench(size: 12, weight: .semibold))
                    .lineLimit(1)
                Spacer()
                if let status = session?.status, status == "exited" {
                    Text("exited").font(.workbench(size: 11)).foregroundStyle(AppColors.warning)
                }
                Button("Close") {
                    if let id = session?.id { client.send(CommandFactory.closeTerminal(id: id), label: "Close terminal") }
                    onClose()
                }
                .font(.workbench(size: 12, weight: .medium))
                .accessibilityIdentifier("terminal-close")
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(AppColors.raised)

            if client.terminal == nil && client.status == .open {
                ContentUnavailableView("Host terminal unavailable", systemImage: "terminal", description: Text("Connect to a host that exposes the terminal protocol."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                GeometryReader { geo in
                    let metrics = terminalMetrics(in: geo.size)
                    TerminalScreen(frame: frame, cols: metrics.cols, rows: metrics.rows)
                        .onAppear {
                            cols = metrics.cols
                            rows = metrics.rows
                            openIfNeeded(cols: metrics.cols, rows: metrics.rows)
                        }
                        .onChange(of: metrics.cols) { _, next in resize(cols: next, rows: metrics.rows) }
                        .onChange(of: metrics.rows) { _, next in resize(cols: metrics.cols, rows: next) }
                }
                TerminalInputBar(focused: $inputFocused, onSend: send, onControl: sendControl)
            }
        }
        .background(Color.black)
        .accessibilityIdentifier("terminal-panel")
        .onAppear {
            if session == nil { client.send(CommandFactory.openTerminal(cols: cols, rows: rows), label: "Open terminal") }
            inputFocused = true
        }
    }

    private func openIfNeeded(cols: Int, rows: Int) {
        if session == nil {
            client.send(CommandFactory.openTerminal(cols: cols, rows: rows), label: "Open terminal")
        } else if let id = session?.id {
            client.send(CommandFactory.resizeTerminal(id: id, cols: cols, rows: rows), label: "Resize terminal")
        }
    }

    private func resize(cols: Int, rows: Int) {
        self.cols = cols
        self.rows = rows
        guard let id = session?.id else { return }
        client.send(CommandFactory.resizeTerminal(id: id, cols: cols, rows: rows), label: "Resize terminal")
    }

    private func send(_ text: String) {
        guard let id = session?.id, !text.isEmpty else { return }
        client.send(CommandFactory.writeTerminal(id: id, data: text), label: "Terminal input")
    }

    private func sendControl(_ data: String) { send(data) }

    private func terminalMetrics(in size: CGSize) -> (cols: Int, rows: Int) {
        let charWidth: CGFloat = 7.2
        let lineHeight: CGFloat = 15
        let cols = max(2, min(240, Int(size.width / charWidth)))
        let rows = max(1, min(80, Int(size.height / lineHeight)))
        return (cols, rows)
    }
}

private struct TerminalScreen: View {
    let frame: RemoteTerminalFrame?
    let cols: Int
    let rows: Int

    var body: some View {
        let lines = paddedLines
        let cursorX = frame?.cursorX ?? 0
        let cursorY = frame?.cursorY ?? 0
        ScrollViewReader { _ in
            ScrollView([.horizontal, .vertical], showsIndicators: true) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        Text(displayLine(line, row: index, cursorX: cursorX, cursorY: cursorY, showCursor: frame?.cursorVisible != false))
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Color.green.opacity(0.9))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(8)
            }
        }
        .accessibilityIdentifier("terminal-screen")
        .accessibilityLabel(lines.joined(separator: "\n"))
    }

    private var paddedLines: [String] {
        var lines = frame?.lines ?? []
        if lines.count < rows { lines.append(contentsOf: Array(repeating: "", count: rows - lines.count)) }
        if lines.count > rows { lines = Array(lines.suffix(rows)) }
        return lines
    }

    private func displayLine(_ line: String, row: Int, cursorX: Int, cursorY: Int, showCursor: Bool) -> AttributedString {
        var text = AttributedString(line.isEmpty ? " " : line)
        text.font = .system(size: 12, design: .monospaced)
        if showCursor, row == cursorY {
            let chars = Array(line)
            if cursorX >= 0 && cursorX < chars.count {
                let start = text.index(text.startIndex, offsetByCharacters: cursorX)
                let end = text.index(start, offsetByCharacters: 1)
                text[start..<end].backgroundColor = .green
                text[start..<end].foregroundColor = .black
            } else {
                text.append(AttributedString("█"))
            }
        }
        return text
    }
}

private struct TerminalInputBar: View {
    var focused: FocusState<Bool>.Binding
    var onSend: (String) -> Void
    var onControl: (String) -> Void
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                control("Esc") { onControl("\u{1b}") }
                control("Tab") { onControl("\t") }
                control("^C") { onControl("\u{3}") }
                control("↑") { onControl("\u{1b}[A") }
                control("↓") { onControl("\u{1b}[B") }
                control("←") { onControl("\u{1b}[D") }
                control("→") { onControl("\u{1b}[C") }
                Spacer()
            }
            HStack(spacing: 8) {
                TextField("Type to the host shell", text: $draft)
                    .font(.system(size: 13, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused(focused)
                    .onSubmit { submit() }
                    .accessibilityIdentifier("terminal-input")
                Button("Send") { submit() }
                    .font(.workbench(size: 12, weight: .medium))
                    .disabled(draft.isEmpty)
                    .accessibilityIdentifier("terminal-send")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(AppColors.card)
    }

    private func submit() {
        var payload = draft
        if !payload.hasSuffix("\n") { payload += "\n" }
        onSend(payload)
        draft = ""
    }

    private func control(_ label: String, action: @escaping () -> Void) -> some View {
        Button(label, action: action)
            .font(.workbench(size: 11, weight: .medium))
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(AppColors.raised)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .accessibilityLabel(label)
    }
}
