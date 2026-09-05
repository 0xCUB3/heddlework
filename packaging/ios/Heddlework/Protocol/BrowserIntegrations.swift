import Foundation

struct BrowserIntegrationChoice: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let available: Bool
    let description: String
}
struct BrowserIntegrationTask: Decodable, Equatable, Identifiable {
    let id: String
    let integrationId: String
    let profile: String
    let prompt: String
    let status: String
    let output: String
    let expiresAt: Double
}
struct BrowserIntegrationSnapshot: Decodable, Equatable {
    let choices: [BrowserIntegrationChoice]
    let selectedId: String
    let profile: String
    let task: BrowserIntegrationTask?
    let error: String?
}
