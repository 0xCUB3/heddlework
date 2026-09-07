import Foundation
import SwiftUI

enum WorkbenchFont {
    static func sans(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.workbench(size: size, weight: weight)
    }

    static func mono(_ size: CGFloat) -> Font {
        Font.workbench(size: size, design: .monospaced)
    }
}

extension Font {
    static func workbench(size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        if design == .monospaced { return .custom("Menlo", size: size) }
        let name: String
        switch weight {
        case .bold, .heavy, .black: name = "HelveticaNeue-Bold"
        case .semibold, .medium: name = "HelveticaNeue-Medium"
        case .light, .ultraLight, .thin: name = "HelveticaNeue-Light"
        default: name = "Helvetica Neue"
        }
        return .custom(name, size: size)
    }
}

enum WorkbenchLayoutMetrics {
    static let fallbackSidebar: CGFloat = 256
    static let fallbackHeader: CGFloat = 52
    static let fallbackContentMax: CGFloat = 768
    static let fallbackSettingsMax: CGFloat = 720
    static let composerRadius: CGFloat = 22
    static let composerMinHeight: CGFloat = 148
    static let composerSend: CGFloat = 34
    static let composerContextHeight: CGFloat = 48
    static let composerContextInset: CGFloat = 22
    static let composerOverlap: CGFloat = 32
    static let sessionCardHeight: CGFloat = 78
    static let sessionCompactHeight: CGFloat = 36
    static let sidebarFooterHeight: CGFloat = 46
    static let rightPanelWidth: CGFloat = 520

    static func sidebarWidth(_ contract: UIContract) -> CGFloat {
        CGFloat(contract.layout?.sidebarWidth ?? Double(fallbackSidebar))
    }

    static func headerHeight(_ contract: UIContract) -> CGFloat {
        CGFloat(contract.layout?.headerHeight ?? Double(fallbackHeader))
    }

    static func contentMaxWidth(_ contract: UIContract) -> CGFloat {
        CGFloat(contract.layout?.contentMaxWidth ?? Double(fallbackContentMax))
    }

    static func settingsMaxWidth(_ contract: UIContract) -> CGFloat {
        CGFloat(contract.layout?.settingsMaxWidth ?? Double(fallbackSettingsMax))
    }

    static func standardPanelWidth(mainWidth: CGFloat) -> CGFloat {
        min(mainWidth, max(420, floor(mainWidth * 0.44)))
    }

    static func notificationsPanelWidth(mainWidth: CGFloat) -> CGFloat {
        min(422, mainWidth)
    }
}

enum SessionLifecycle {
    static let settledAfterMs: Double = 7 * 24 * 60 * 60 * 1_000

    static func bucket(session: SessionSummary, lifecycle: ThreadLifecycle?, now: Date = Date()) -> LifecycleBucket {
        let nowMs = now.timeIntervalSince1970 * 1_000
        let modified = session.modifiedAt ?? session.updatedAt ?? 0
        if (lifecycle?.snoozedUntil ?? 0) > nowMs { return .snoozed }
        if (lifecycle?.settledAt ?? 0) >= modified { return .settled }
        if (lifecycle?.unsettledAt ?? 0) > modified { return .active }
        if nowMs - modified > settledAfterMs { return .settled }
        return .active
    }
}

enum LifecycleBucket: String {
    case active, snoozed, settled
}

enum SessionCatalog {
    static func projectName(for session: SessionSummary) -> String {
        guard let cwd = session.cwd, !cwd.isEmpty else { return "Unknown project" }
        return URL(fileURLWithPath: cwd).lastPathComponent.isEmpty ? cwd : URL(fileURLWithPath: cwd).lastPathComponent
    }

    static func isCurrentSession(_ session: SessionSummary, state: SessionState?) -> Bool {
        if let file = state?.sessionFile, !file.isEmpty { return session.path == file }
        if let sessionId = state?.sessionId, !sessionId.isEmpty { return session.id == sessionId }
        return false
    }

    static func activeThreadTitle(snapshot: WorkbenchSnapshot?) -> String {
        guard let snapshot else { return "New thread" }
        if let name = snapshot.session?.sessionName, !name.isEmpty { return name }
        if let file = snapshot.session?.sessionFile,
           let current = snapshot.sessions?.first(where: { $0.path == file }) {
            return current.displayTitle
        }
        if let firstUser = snapshot.messages?.first(where: { $0.role == "user" }) {
            let text = firstUser.contentText.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { return "New thread" }
            return text.count > 68 ? String(text.prefix(65)) + "…" : text
        }
        return "New thread"
    }

    static func footerLabel(session: SessionSummary) -> String? {
        guard let branch = session.branch, !branch.isEmpty else { return nil }
        return branch
    }

    static func relativeTime(from timestamp: Double?) -> String {
        guard let timestamp else { return "now" }
        let seconds = max(0, Int((Date().timeIntervalSince1970 * 1_000 - timestamp) / 1_000))
        if seconds < 60 { return "now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    static func snoozeOptions(from now: Date = Date()) -> [(label: String, until: Double)] {
        let nowMs = now.timeIntervalSince1970 * 1_000
        var tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now
        tomorrow = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        var nextWeek = Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now
        let weekday = Calendar.current.component(.weekday, from: nextWeek)
        let daysUntil = ((8 - weekday) % 7 == 0) ? 7 : (8 - weekday) % 7
        nextWeek = Calendar.current.date(byAdding: .day, value: daysUntil, to: nextWeek) ?? nextWeek
        nextWeek = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: nextWeek) ?? nextWeek
        return [
            ("In 1 hour", nowMs + 3_600_000),
            ("In 3 hours", nowMs + 3 * 3_600_000),
            ("Tomorrow", tomorrow.timeIntervalSince1970 * 1_000),
            ("Next week", nextWeek.timeIntervalSince1970 * 1_000),
        ]
    }
}

struct ContentMaxWidth: ViewModifier {
    let width: CGFloat
    func body(content: Content) -> some View {
        content.frame(maxWidth: width).frame(maxWidth: .infinity)
    }
}

extension View {
    func contentMaxWidth(_ contract: UIContract) -> some View {
        modifier(ContentMaxWidth(width: WorkbenchLayoutMetrics.contentMaxWidth(contract)))
    }

    func settingsMaxWidth(_ contract: UIContract) -> some View {
        frame(maxWidth: WorkbenchLayoutMetrics.settingsMaxWidth(contract))
            .frame(maxWidth: .infinity)
    }
}
