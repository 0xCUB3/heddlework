import Foundation
import SwiftUI
import UIKit

struct UIContract: Decodable {
    struct Item: Decodable, Identifiable { let id: String; let label: String }
    struct Layout: Decodable {
        let touchTarget: Double?
        let contentMaxWidth: Double?
        let settingsMaxWidth: Double?
        let sidebarWidth: Double?
        let headerHeight: Double?
    }
    struct Palette: Decodable {
        let window: String?
        let background: String?
        let sidebar: String?
        let sidebarActive: String?
        let sidebarHover: String?
        let card: String?
        let raised: String?
        let border: String?
        let borderStrong: String?
        let text: String?
        let textMuted: String?
        let textFaint: String?
        let primary: String?
        let info: String?
        let success: String?
        let error: String?
        let warning: String?
        let settledText: String?
        let settledMeta: String?
        let settledIcon: String?
        let settledDivider: String?
        let composer: String?
        let composerFrame: String?
        let composerHighlight: String?
        let contextBar: String?
        let contextText: String?
        let contextIcon: String?
        let composerOutline: String?
    }
    struct ColorSet: Decodable { let light: Palette; let dark: Palette }

    let version: Int
    let surfaces: [Item]
    let panels: [Item]
    let settings: [Item]
    let layout: Layout?
    let colors: ColorSet?

    static let fallback = UIContract(
        version: 1,
        surfaces: [Item(id: "chat", label: "Chat"), Item(id: "flows", label: "Flows"), Item(id: "settings", label: "Settings")],
        panels: [Item(id: "notifications", label: "Notifications"), Item(id: "surfaces", label: "Surfaces"), Item(id: "diff", label: "Changes"), Item(id: "queue", label: "Queue"), Item(id: "triage", label: "Triage"), Item(id: "receipts", label: "Receipts")],
        settings: [
            Item(id: "runtime", label: "Runtime"),
            Item(id: "interface", label: "Interface"),
            Item(id: "remote-access", label: "Remote access"),
            Item(id: "updates", label: "Updates"),
            Item(id: "plugins", label: "Plugins"),
            Item(id: "terminal", label: "Terminal"),
            Item(id: "browser", label: "Browser"),
            Item(id: "about", label: "About")
        ],
        layout: Layout(touchTarget: 44, contentMaxWidth: 768, settingsMaxWidth: 720, sidebarWidth: 256, headerHeight: 52),
        colors: nil
    )

    static func load() -> UIContract {
        let urls = [
            Bundle.main.url(forResource: "ui-contract", withExtension: "json"),
            Bundle.main.url(forResource: "ui-contract", withExtension: "json", subdirectory: "workbench")
        ].compactMap { $0 }
        for url in urls {
            if let data = try? Data(contentsOf: url), let contract = try? JSONDecoder().decode(UIContract.self, from: data) { return contract }
        }
        return fallback
    }
}

enum WorkspaceSurface: String, CaseIterable, Identifiable { case chat, flows, settings; var id: String { rawValue } }
enum DetailPanel: String, CaseIterable, Identifiable { case notifications, surfaces, diff, queue, triage, receipts; var id: String { rawValue } }

enum AppColors {
    static var contract = UIContract.load()

    static var window: Color { color(\.window, fallbackLight: "#FDFDFD", fallbackDark: "#0A0A0A") }
    static var sidebar: Color { color(\.sidebar, fallbackLight: "#FAFAFA", fallbackDark: "#090A0B") }
    static var sidebarActive: Color { color(\.sidebarActive, fallbackLight: "#FFFFFF", fallbackDark: "#1B1C1D") }
    static var card: Color { color(\.card, fallbackLight: "#FFFFFF", fallbackDark: "#111212") }
    static var raised: Color { color(\.raised, fallbackLight: "#ECECEF", fallbackDark: "#151616") }
    static var border: Color { color(\.border, fallbackLight: "#E4E4E7", fallbackDark: "#1D1E1E") }
    static var text: Color { color(\.text, fallbackLight: "#27272A", fallbackDark: "#E7E7E7") }
    static var muted: Color { color(\.textMuted, fallbackLight: "#71717A", fallbackDark: "#A0A0A3") }
    static var primary: Color { color(\.primary, fallbackLight: "#1B4ED8", fallbackDark: "#346BF1") }
    static var background: Color { color(\.background, fallbackLight: "#FDFDFD", fallbackDark: "#0A0A0A") }
    static var sidebarHover: Color { color(\.sidebarHover, fallbackLight: "#FDFDFD", fallbackDark: "#151617") }
    static var textFaint: Color { color(\.textFaint, fallbackLight: "#85868D", fallbackDark: "#66676A") }
    static var borderStrong: Color { color(\.borderStrong, fallbackLight: "#D0D0D5", fallbackDark: "#2A2B2B") }
    static var info: Color { color(\.info, fallbackLight: "#2563B8", fallbackDark: "#60A5FA") }
    static var success: Color { color(\.success, fallbackLight: "#16845B", fallbackDark: "#4ADEA4") }
    static var warning: Color { color(\.warning, fallbackLight: "#9A6700", fallbackDark: "#F1C75B") }
    static var error: Color { color(\.error, fallbackLight: "#C43D45", fallbackDark: "#F87171") }
    static var settledText: Color { color(\.settledText, fallbackLight: "#898A90", fallbackDark: "#595A5D") }
    static var settledMeta: Color { color(\.settledMeta, fallbackLight: "#96979C", fallbackDark: "#4D4E51") }
    static var settledIcon: Color { color(\.settledIcon, fallbackLight: "#929399", fallbackDark: "#4B4C4F") }
    static var settledDivider: Color { color(\.settledDivider, fallbackLight: "#DEDEE2", fallbackDark: "#191A1B") }
    static var composer: Color { color(\.composer, fallbackLight: "#FFFFFF", fallbackDark: "#121212") }
    static var composerFrame: Color { color(\.composerFrame, fallbackLight: "#DCDCE1", fallbackDark: "#1E1E1E") }
    static var composerHighlight: Color { color(\.composerHighlight, fallbackLight: "#F0F0F2", fallbackDark: "#191919") }
    static var contextBar: Color { color(\.contextBar, fallbackLight: "#F0F0F2", fallbackDark: "#171717") }
    static var contextText: Color { color(\.contextText, fallbackLight: "#696A71", fallbackDark: "#767679") }
    static var contextIcon: Color { color(\.contextIcon, fallbackLight: "#7C7D83", fallbackDark: "#5F6063") }
    static var composerOutline: Color { color(\.composerOutline, fallbackLight: "#D4D4D9", fallbackDark: "#282828") }

    static func color(_ keyPath: KeyPath<UIContract.Palette, String?>, fallbackLight: String, fallbackDark: String) -> Color {
        let lightHex = contract.colors?.light[keyPath: keyPath] ?? fallbackLight
        let darkHex = contract.colors?.dark[keyPath: keyPath] ?? fallbackDark
        return Color(UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? darkHex : lightHex) ?? UIColor.label
        })
    }
}

extension UIColor {
    convenience init?(hex: String) {
        var raw = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.hasPrefix("#") { raw.removeFirst() }
        guard raw.count == 6 || raw.count == 8, let value = UInt64(raw, radix: 16) else { return nil }
        let hasAlpha = raw.count == 8
        let r = CGFloat((value >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let g = CGFloat((value >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let b = CGFloat((value >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let a = hasAlpha ? CGFloat(value & 0xff) / 255 : 1
        self.init(red: r, green: g, blue: b, alpha: a)
    }
}
