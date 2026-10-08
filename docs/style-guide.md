# Subpolar Agent Style Guide

This guide documents the shared visual color tokens used by the Subpolar Agent UI. The source of truth is `@subpolar-agent/src/index.css`.

## Theme behavior

The base `@theme` values define the dark palette. The light palette is applied by `:root:not(.dark)`. Prefer the semantic CSS variables/Tailwind theme colors below rather than hardcoding hex values in components, so UI elements adapt when the theme changes.

## Dark palette

| Token | Value | Intended use |
|---|---|---|
| `background` | `#0a0a0a` | Page and app background |
| `foreground` | `#fafafa` | Primary text |
| `card` | `#141414` | Raised surfaces and cards |
| `card-hover` | `#1a1a1a` | Hovered card surfaces |
| `border` | `#2a2a2a` | Standard borders and outlines |
| `primary` | `#5eaadd` | Primary actions, links, focus |
| `primary-hover` | `#4e99cc` | Hovered primary actions |
| `primary-foreground` | `#fafafa` | Text/icons on primary surfaces |
| `muted-foreground` | `#d4d4d8` | Secondary or subdued text |
| `accent` | `#27272a` | Accent surfaces |
| `accent-foreground` | `#fafafa` | Text/icons on accent surfaces |
| `input` | `#323232` | Input borders/surfaces |
| `muted` | `#18181b` | Muted surfaces |
| `popover` | `#18181b` | Popover surfaces |
| `destructive` | `#dc2626` | Destructive actions and errors |
| `secondary` | `#27272a` | Secondary surfaces/actions |
| `secondary-foreground` | `#fafafa` | Text/icons on secondary surfaces |
| `overlay` | `rgba(0, 0, 0, 0.55)` | Modal/backdrop overlay |

## Light palette

| Token | Value | Intended use |
|---|---|---|
| `background` | `#ffffff` | Page and app background |
| `foreground` | `#111827` | Primary text |
| `card` | `#f9fafb` | Raised surfaces and cards |
| `card-hover` | `#f3f4f6` | Hovered card surfaces |
| `border` | `#e5e7eb` | Standard borders and outlines |
| `primary` | `#1d4ed8` | Primary actions, links, focus |
| `primary-hover` | `#1e40af` | Hovered primary actions |
| `primary-foreground` | `#ffffff` | Text/icons on primary surfaces |
| `muted-foreground` | `#6b7280` | Secondary or subdued text |
| `accent` | `#f3f4f6` | Accent surfaces |
| `accent-foreground` | `#111827` | Text/icons on accent surfaces |
| `input` | `#e5e7eb` | Input borders/surfaces |
| `muted` | `#f4f4f5` | Muted surfaces |
| `popover` | `#ffffff` | Popover surfaces |
| `destructive` | `#dc2626` | Destructive actions and errors |
| `secondary` | `#f4f4f5` | Secondary surfaces/actions |
| `secondary-foreground` | `#111827` | Text/icons on secondary surfaces |
| `overlay` | `rgba(0, 0, 0, 0.35)` | Modal/backdrop overlay |

## Semantic aliases

Use these semantic aliases when they better express the component's role. They resolve to the theme tokens and switch with the active palette:

| Alias | Resolves to |
|---|---|
| `surface` | `background` |
| `surface-raised` | `card` |
| `surface-hover` | `card-hover` |
| `outline` | `border` |
| `focus` | `primary` |
| `on-accent` | `primary-foreground` |
| `danger` | `destructive` |

## Component-specific border colors

Dialog content and nested cards use `#343434` borders in dark mode and `#d1d5db` in light mode. These are currently explicit component overrides in `@subpolar-agent/src/index.css` rather than general theme tokens.

## Usage guidance

- Use semantic theme tokens instead of literal colors for ordinary component styling.
- Use `primary` for interactive emphasis; retain `primary-hover` for its hover state.
- Keep text and icon colors paired with the corresponding `*-foreground` token on colored surfaces.
- Use `destructive`/`danger` only for destructive or error states, not general emphasis.
- If a new recurring color is needed, add a semantic token to both palettes in `@subpolar-agent/src/index.css` and document it here.
