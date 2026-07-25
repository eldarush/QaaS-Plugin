# QaaS Plugin documentation design

## Direction: acceptance ledger

The site borrows from a laboratory acceptance ledger and an operations control
strip. It should feel exact, calm, and inspectable: cool paper, navy ink,
saffron status markers, and vermilion only where a decision or prohibition
deserves attention. It rejects the generic documentation portal made from
same-sized feature cards.

The surface is in **Read** mode. Comprehension and wayfinding outrank spectacle.
One state-change reveal is permitted when a hash route changes; page-load
choreography and decorative motion are not.

Visible copy is evergreen and task-led. Each route opens with the shortest
useful decision or action, then exposes compact cards, registers, or tables
only when they improve scanning.

## Typography

- Display and headings: a narrow industrial system stack led by Bahnschrift,
  with a Segoe/system fallback.
- Body and controls: a workhorse Segoe/system sans stack.
- Code, commands, versions, and measurement labels only: Cascadia/Consolas
  monospace stack.
- Ordinary body floor: 16px.
- Prose measure: 45–70 characters.
- Heading tracking never tighter than `-0.035em`.
- Hierarchy uses size, weight, spacing, and tone together.

## Color roles

| Role | Token | Value |
| --- | --- | --- |
| Reading ground | `--paper` | `#f3f7f8` |
| Primary ink | `--ink` | `#102a43` |
| Deep control surface | `--navy` | `#102a43` |
| Status / approved attention | `--saffron` | `#f2c94c` |
| Decision / prohibition | `--vermilion` | `#b84223` |
| Navigation / evidence | `--teal` | `#14617a` |

Secondary text is tinted from the navy family, never neutral gray on color.
Borders provide most elevation; only the operational control and real code
panels use one offset, soft shadow.

The default theme follows `prefers-color-scheme`. The main surface also offers
an accessible Auto → Light → Dark control; either explicit palette keeps the
same semantic color roles and contrast targets.

## Composition and components

- A persistent numbered manual index is the primary navigation on wide screens;
  it becomes a horizontal route rail when space is constrained.
- The first viewport prioritizes four short task cards and one compact control
  strip.
- Long-form sections use registers, sequences, tables, and split ledgers only
  when those shapes express actual structure.
- Pills are limited to status and phase tags.
- No nested cards, gradient text, ornamental glass, or decorative technical
  grids.
- Two designated local demo slots hold reviewed literal terminal captures of a
  controlled Codex proxy with scripted operator input and a synthetic fixture.
  Their captions state that they are not customer data or live Claude Code/QaaS
  runtime evidence.

## Accessibility and adaptation

- Keyboard skip link, visible focus, semantic landmarks, route announcements,
  and one `h1` per route.
- Body text meets a 4.5:1 target; large text meets 3:1.
- Touch targets are at least 44px where controls are used.
- Hash routing keeps navigation on the same static document and works without a
  server rewrite. With JavaScript unavailable, all route content remains in the
  document.
- Responsive changes are structural: stacked content, horizontal navigation,
  and scrollable data tables. Core content is never hidden because the device
  is small.
- Reduced-motion, forced-colors, zoom, and print paths have explicit styles.
- Theme state is labeled, keyboard operable, and announced without replacing
  the operating-system default.
