# UI extensions

Heddlework's UI extension boundary is Cordis-inspired but deliberately smaller than a microfrontend system. A feature plugin runs in the existing Bun, React, and GPUIX process and registers one manifest that may contain several related UI contributions.

The first supported seat is the right-side workbench surface. The terminal bottom dock is layout-owned by the workbench shell rather than a UI-extension seat, because it has a single owner. More seats should be added only when multiple real features need the same coarse region. We do not intend to expose every button, row, or layout leaf as a slot.

## Current contract

`WorkbenchUiRegistry` is an observable service provided as `workbenchUiRegistryToken`. The bounded source-level facade is `src/plugin-api.ts`. A plugin declares the registry service in `requires`, then owns its manifest through `ctx.effect()`:

```tsx
import {
  workbenchUiRegistryToken,
  type WorkbenchPlugin,
  type WorkbenchSurfaceProps,
} from '../src/plugin-api.ts'

const reviewPlugin: WorkbenchPlugin = {
  id: 'acme-review',
  requires: [workbenchUiRegistryToken, reviewServiceToken],
  activate(ctx) {
    const review = ctx.get(reviewServiceToken)

    function FindingsSurface(props: WorkbenchSurfaceProps) {
      return <FindingsPanel review={review} onClose={props.onClose} />
    }

    function HistorySurface(props: WorkbenchSurfaceProps) {
      return <HistoryPanel review={review} onClose={props.onClose} />
    }

    ctx.effect(() => ctx.get(workbenchUiRegistryToken).register({
      id: 'acme.review',
      surfaces: [
        {
          id: 'review.findings',
          title: 'Findings',
          description: 'Inspect current review findings.',
          icon: 'eye',
          component: FindingsSurface,
        },
        {
          id: 'review.history',
          title: 'Review history',
          description: 'Browse earlier review runs.',
          icon: 'clock',
          component: HistorySurface,
        },
      ],
    }))
  },
}
```

The host observes registry snapshots, adds every surface to the shared picker, and renders only the selected component. Unloading the plugin removes all of its surfaces and closes an active surface owned by it. Extension and surface IDs are stable and collisions fail before any part of a manifest is installed.

A component receives only shared panel chrome controls. Domain services are captured from the plugin context rather than copied into a second frontend container.

## Guardrails

- A plugin represents a cohesive capability or feature, not one visual element.
- One manifest may register many surfaces. Five surfaces do not require five plugins.
- Extensions share Heddlework's React and GPUIX runtime; there is no iframe, secondary router, independent application store, or per-surface build.
- Business behavior belongs in injected services and typed domain events. Components are views over those capabilities.
- Registrations must be reversible effects. No permanent global mutation or background work owned by a component.
- Seats stay coarse and few. New sidebar, composer, or conversation seats require demonstrated consumers and an owner-props contract.
- The current API is trusted in-process code. Sandboxed or remotely downloaded UI is a separate security problem and is not implied by this registry.

## Foundations already in place

The kernel waits to activate a plugin until its required services exist, suspends dependents before a provider unloads, and reactivates them if a replacement provider appears. Typed `emit`, `parallel`, `serial`, `bail`, and `waterfall` events are owned by plugin lifetimes. Harness transport records now cross that event boundary before the workbench controller consumes them.

Session discovery and workspace diffs are independent services rather than concrete controller imports. These seams are intentionally enough to guide new work; Heddlework does not yet need the full profile, bundle, isolation, or hundreds-of-slots surface of a mature Cordis application.

## External plugins

Heddlework loads third-party plugins at startup from two roots:

- `<state dir>/plugins/*/heddlework-plugin.json`
- `<workspace>/.heddlework/plugins/*/heddlework-plugin.json`

Workspace plugins load only when the workspace is trusted. Trust is stored in `<state dir>/trusted-workspaces.json`. `HEDDLEWORK_TRUST_WORKSPACE=1` overrides that check for one process.

Manifest schema:

```json
{
  "id": "acme.review",
  "name": "Acme Review",
  "version": "1.0.0",
  "entry": "index.ts",
  "heddlework": { "api": "1" }
}
```

`heddlework.api` is compatible when its major version matches `HEDDLEWORK_PLUGIN_API_VERSION` (`1`). `^1` is accepted. Incompatible or throwing plugins are recorded in a load report and skipped; the host keeps running.

The entry default-export is a `WorkbenchPlugin` or a factory `(api) => WorkbenchPlugin`. The factory receives the `src/plugin-api.ts` namespace.

Minimal surface plugin:

```ts
export default function examplePlugin(api: typeof import('../../src/plugin-api.ts')) {
  return {
    id: 'example.hello',
    requires: [api.workbenchUiRegistryToken],
    activate(ctx) {
      ctx.effect(() => ctx.get(api.workbenchUiRegistryToken).register({
        id: 'example.hello',
        surfaces: [{
          id: 'example.hello.panel',
          title: 'Hello',
          description: 'Example external surface.',
          icon: 'panel',
          component: () => null,
        }],
      }))
    },
  }
}
```

Settings shows the load report and a Trust workspace toggle. Permissions, additional UI seats, and a public package SDK remain future work.

## Deferred

Permissions, additional UI seats, and a public package SDK remain future work.

