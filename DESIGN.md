# AARO visual style guide

## Direction

AARO is a Bangladesh-focused, multi-category lifestyle shop. Keep the interface calm, warm, clear, and product-first. Use restrained motion, readable text, consistent spacing, and strong contrast in both light and dark themes. Do not change the existing font families.

## Color tokens

| Use | Light | Dark |
| --- | --- | --- |
| Page | `#F5F7F3` | `#111A17` |
| Main surface | `#FFFFFF` | `#18231F` |
| Soft surface | `#EDF3EC` | `#202F29` |
| Main text | `#183B35` | `#EDF3EF` |
| Supporting text | `#63776E` | `#B4C2BA` |
| Border | `#DCE6DC` | `#34473F` |
| Primary action | `#1D6556` | `#F3AE58` |
| Warm accent | `#ED9B3E` | `#F3AE58` |
| Error | `#A33F36` | `#F08C80` |

Use evergreen for primary actions in light mode and warm orange for emphasis in dark mode. Keep orange text off light surfaces where contrast is weak; use dark ink on orange buttons. Never place muted green text on a similarly dark green surface.

## Typography

- Preserve the current families: Manrope for display/headings, DM Sans for interface/body, and Hind Siliguri for Bangla where already applied.
- Base body size: 16px, line-height 1.55.
- Main page headings: 30–48px, responsive; section headings: 22–28px; card headings: 16–18px.
- Body and form text: 14–16px. Product titles: 16px. Supporting text: 13–14px.
- Metadata, labels, and badges: 12px minimum. Avoid 6–11px interface text.
- Bangla text uses natural word spacing and line-height of at least 1.55; do not alter the typeface to solve spacing issues.

## Layout and components

- Content width: at most 1320px, with 24–36px desktop gutters and 16px mobile gutters.
- Use a 4px spacing base; favor 8, 12, 16, 24, 32, and 48px.
- Use 8–12px corner radii for cards and controls; pills are fully rounded.
- Keep product imagery prominent and product cards consistent in padding, text alignment, and footer spacing.
- Use the same surface, border, and text tokens in the storefront, admin panels, forms, tables, menus, and dialogs.
- Buttons have at least 44px touch height where practical, clear labels, and visible hover/focus states.
- Tables remain scrollable on narrow screens. Menus and drawers must fit the viewport and keep all content reachable.

## Motion and accessibility

- Use short, purposeful transitions (150–220ms) for color, opacity, and small position changes.
- Do not animate layout in ways that hide content or cause color flashes while a drawer closes.
- Respect `prefers-reduced-motion`.
- Maintain visible keyboard focus and readable contrast. Do not communicate status by color alone.

## Content integrity

- Dashboard charts and counts must come from persisted application data. When there is no data, show an honest empty state; never use invented sales, ratings, views, or coupon examples.
- Do not ship fake catalog importers, nonfunctional shopping flows, or “demo” claims. Clearly distinguish browser-only admin edits from server-saved changes until they are stored in the backend.
