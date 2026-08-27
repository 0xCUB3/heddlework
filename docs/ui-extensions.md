# UI extensions

Heddlework's UI extension boundary is Cordis-inspired but deliberately smaller than a microfrontend system. A feature plugin runs in the existing Bun, React, and GPUIX process and registers one manifest that may contain several related UI contributions.

The first supported seat is the right-side workbench surface. More seats should be added only when multiple real features need the same coarse region. We do not intend to expose every button, row, or layout leaf as a slot.

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

## Deferred

External package discovery, compatibility metadata, permissions, additional UI seats, and a public package SDK remain future work. Until then, plugins are mounted in the application composition root and use source-level TypeScript contracts.
