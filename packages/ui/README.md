# Cockpit UI source

This private workspace contains the shadcn/ui components used by Cockpit's new
Web entry. It is not a second application or a catalog of module-only controls.
Business views compose these components; changes to their common appearance,
focus behavior or interaction defaults belong here.

The initial sources were downloaded with the official `shadcn@4.21.0` CLI using
the `radix-nova` registry style and neutral base color. `components.json` records
the configuration. The registry is mutable: the CLI version is not a promise
that its remote source never changes. Our Git history freezes the actual
vendored bytes. Preserve `LICENSE.shadcn` and the build's dependency notices.
Relevant upstream correctness, accessibility and security fixes still need
deliberate adoption; vendoring does not eliminate maintenance.
The theme includes the state/orientation aliases used by these components from
[shadcn's Tailwind support](https://github.com/shadcn-ui/ui/blob/main/packages/shadcn/src/tailwind.css).
They map the source's shorthand variants to actual Radix attributes.

The intentional local defaults are:

- Neutral light/dark semantic colors and reduced-motion support.
- Compact desktop controls; 44px coarse-pointer action targets. Checkbox and
  switch hit areas expand without enlarging their visible marks. Consumers must
  space these controls so those hit areas do not overlap.
- Chinese dialog close labels, reserved header space for the common close
  control, viewport-constrained scrollable dialog content, and footer actions
  whose visual order follows DOM and keyboard order on every screen size.
- Content-sized action menus, constrained by the viewport, rather than menus
  that copy an arbitrarily wide or narrow trigger.

Only the new Web entry imports `styles/theme.css`. Its Tailwind sources are
explicitly restricted to this package and new host views; classic styles and
external module source are not scanned. Do not import this theme into classic.

Independent modules receive the actual shared components through the public
`ModuleNextFrontendContext.ui` capability, not workspace imports. The contract
is maintained in `packages/module-api/src/ui.ts`, and the host's namespace is
checked against it in `apps/web/src/next/ui.ts`. Modules retain their own business
layout and state. Module-only primitives belong in the module repository, with
their provenance and licenses, the same injected React, and isolated styles
without a second global reset. See the [module UI guide](../../docs/module-ui-guide.md).

Adding a component requires an actual host use. Update the public capability
only when it should be shared, and keep compound component parts in one
implementation instance. Do not silently replace a component's public
behavior with page-specific selector overrides.
