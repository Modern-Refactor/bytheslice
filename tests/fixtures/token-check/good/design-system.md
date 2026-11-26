# Design System

> Fixture for tests/set-display-case: a filled design-system.md with no open slots.

## Surface Colors

| Token | Light | Dark | Usage |
| --- | --- | --- | --- |
| `--background` | 0 0% 100% | 0 0% 4% | Page background |
| `--card` | 0 0% 96% | 0 0% 8% | Card surface |

## Typography: Type Scale

**Approach chosen:** Size tokens (Option A)

| Token | Value | Usage |
| --- | --- | --- |
| `--text-xs` | 0.75rem | 12px equivalent |
| `--text-sm` | 0.875rem | 14px equivalent |
| `--text-base` | 1rem | 16px equivalent |
| `--text-lg` | 1.125rem | 18px equivalent |
| `--text-xl` | 1.25rem | 20px equivalent |
| `--text-2xl` | 1.5rem | 24px equivalent |
| `--text-3xl` | 1.875rem | 30px equivalent |
| `--text-4xl` | 2.25rem | 36px equivalent |

## Typography: Weights, Leading, Tracking

### Font Weights

| Name | Value |
| --- | --- |
| Regular | 400 |
| Medium | 500 |
| Semibold | 600 |
| Bold | 700 |

### Line Heights (Leading)

| Name | Value |
| --- | --- |
| Tight | 1.25 |
| Normal | 1.5 |
| Relaxed | 1.75 |

### Letter Spacing (Tracking)

| Name | Value |
| --- | --- |
| Tight | -0.01em |
| Normal | 0 |
| Wide | 0.02em |

## Spacing

**Spacing Decision:** Using the Tailwind default 4px-base scale.

## Motion

**Motion Decision:** Defined as CSS custom properties in `globals.css`.

| Token / Name | Value | Usage |
| --- | --- | --- |
| Fast | 150ms | Micro-interactions |
| Normal | 250ms | Standard transitions |
| Slow | 450ms | Large panels |

## Breakpoints

**Breakpoint Decision:** Using Tailwind defaults.

| Name | Value |
| --- | --- |
| `sm` | 640px |
| `md` | 768px |
| `lg` | 1024px |
| `xl` | 1280px |
| `2xl` | 1536px |

## Z-index

| Layer | Value | Usage |
| --- | --- | --- |
| Base | 0 | Document flow |
| Dropdown | 1000 | Menus |
| Modal | 1300 | Dialogs |
| Toast | 1400 | Notifications |
| Tooltip | 1500 | Always topmost |

## Dark Mode

**Dark Mode Strategy:** `.dark` class on the `<html>` element (Tailwind `darkMode: "class"`).

**Color Format:** HSL.
