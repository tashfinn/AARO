# AARO visual style guide

## Direction

AARO is a Bangladesh-focused, multi-category lifestyle shop. The visual system is warm, composed, product-first, and practical for shoppers and store staff. Keep the recognizable evergreen and orange brand cues while using one shared surface and contrast system across the storefront and admin. Preserve the existing font families: Manrope for display, DM Sans for interface copy, and Hind Siliguri for Bangla.

## Color tokens

| Role | Light | Dark |
| --- | --- | --- |
| Page canvas | `#F4F6F1` | `#111915` |
| Main surface | `#FFFEFA` | `#1B2620` |
| Raised surface | `#F7F8F3` | `#23322A` |
| Inset / input | `#EDF2EC` | `#14201A` |
| Primary text | `#183B35` | `#F0F4F0` |
| Supporting text | `#526A5F` | `#C5D0C9` |
| Muted text | `#65796E` | `#AEBBB3` |
| Border | `#D9E3DA` | `#3D5146` |
| Primary action | `#1D6556` | `#F0A54E` |
| Accent text | `#A65316` | `#FFC477` |
| Error | `#A33F36` | `#FFC0B7` |

Evergreen is the light-theme primary action; orange is used for warm highlights and dark-theme primary actions. Orange action buttons use dark ink. Supporting text must remain readable on its actual surface. Avoid pale text on cream panels, muted green on deep green, and green labels on green cards. Status colors use their own paired foreground and background rather than color alone.

## Typography

- Preserve Manrope, DM Sans, and Hind Siliguri; do not replace the fonts.
- Body copy uses 15px with 1.5–1.65 line-height. Controls and compact interface labels use 14px or larger.
- Page headings use 30–48px; section headings 22–28px; card headings 16–20px.
- Form labels, buttons, sync details, metadata, and badges stay at 14px or larger where space allows; compact decorative labels may use 13px.
- Bangla uses Hind Siliguri, natural word spacing, and a line-height of at least 1.55.

## Layout and components

- Keep the existing page structure and behavior. Theme changes should not rearrange shopping or admin workflows.
- Content width stays at or below 1320px, with 24–36px desktop gutters and 16px mobile gutters.
- Use a 4px spacing base; favor 8, 12, 16, 24, 32, and 48px.
- Cards and dialogs use 10–12px corners. Controls use 8px corners. Pills are reserved for compact statuses.
- Use a single border and surface hierarchy; avoid unrelated white blocks inside dark pages.
- Buttons target at least 44px height when practical, with clear text, hover, disabled, and keyboard-focus states.
- Tables scroll on narrow screens; expanded menus and sidebars remain reachable and do not flash to a different theme while closing.

## Motion and accessibility

- Use 150–220ms transitions for color, opacity, and small movement. Respect reduced-motion preferences.
- Maintain at least 4.5:1 contrast for body and placeholder copy, and 3:1 for large text and essential interface boundaries.
- Use visible focus rings, themed selection and scrollbars, and clear error/success/warning text.
- Keep content visible by default; no decorative animation should hide information or controls.

## Content integrity

- Dashboard charts and counts use persisted application data. With no data, show an honest empty state; never invent sales, ratings, views, or coupon examples.
- Do not ship fake catalog importers, nonfunctional shopping flows, or “demo” claims. Clearly distinguish browser-only admin edits from server-saved changes until they are stored in the backend.
