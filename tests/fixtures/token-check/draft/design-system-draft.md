# Design System Draft

> Fixture for tests/set-display-case: the approved token map token-expander writes before the final files.

## Color Tokens

| Token | Light | Dark |
| --- | --- | --- |
| `--background` | 0 0% 100% | 0 0% 4% |
| `--foreground` | 222 47% 11% | 210 40% 98% |
| `--card` | 0 0% 96% | 0 0% 8% |
| `--card-foreground` | 222 47% 11% | 210 40% 98% |
| `--popover` | 0 0% 92% | 0 0% 12% |
| `--popover-foreground` | 222 47% 11% | 210 40% 98% |
| `--primary` | 221 83% 53% | 217 91% 60% |
| `--primary-foreground` | 0 0% 100% | 222 47% 11% |
| `--secondary` | 210 40% 90% | 217 33% 20% |
| `--secondary-foreground` | 222 47% 11% | 210 40% 98% |
| `--accent` | 199 89% 48% | 199 89% 55% |
| `--accent-foreground` | 0 0% 100% | 222 47% 11% |
| `--destructive` | 0 84% 60% | 0 63% 45% |
| `--destructive-foreground` | 0 0% 100% | 210 40% 98% |
| `--success` | 142 71% 45% | 142 60% 40% |
| `--success-foreground` | 0 0% 100% | 210 40% 98% |
| `--muted` | 0 0% 94% | 0 0% 10% |
| `--muted-foreground` | 215 16% 40% | 215 20% 65% |
| `--border` | 214 32% 85% | 217 33% 20% |
| `--input` | 214 32% 85% | 217 33% 20% |
| `--ring` | 221 83% 53% | 217 91% 60% |
| `--chart-1` | 221 83% 53% | 217 91% 60% |
| `--chart-2` | 142 71% 45% | 142 60% 50% |
| `--chart-3` | 38 92% 50% | 38 92% 55% |
| `--chart-4` | 280 65% 60% | 280 65% 65% |
| `--chart-5` | 0 84% 60% | 0 72% 55% |
| `--sidebar` | 0 0% 97% | 0 0% 7% |
| `--sidebar-foreground` | 222 47% 11% | 210 40% 98% |
| `--sidebar-primary` | 221 83% 53% | 217 91% 60% |
| `--sidebar-primary-foreground` | 0 0% 100% | 222 47% 11% |
| `--sidebar-accent` | 210 40% 90% | 217 33% 20% |
| `--sidebar-accent-foreground` | 222 47% 11% | 210 40% 98% |
| `--sidebar-border` | 214 32% 85% | 217 33% 20% |
| `--sidebar-ring` | 221 83% 53% | 217 91% 60% |

## Other Tokens

| Token | Value |
| --- | --- |
| `--font-sans` | "Inter", ui-sans-serif, system-ui, sans-serif |
| `--font-serif` | "Source Serif 4", ui-serif, Georgia, serif |
| `--font-mono` | "JetBrains Mono", ui-monospace, monospace |
| `--text-xs` | 0.75rem |
| `--text-sm` | 0.875rem |
| `--text-base` | 1rem |
| `--text-lg` | 1.125rem |
| `--text-xl` | 1.25rem |
| `--text-2xl` | 1.5rem |
| `--text-3xl` | 1.875rem |
| `--text-4xl` | 2.25rem |
| `--radius` | 0.5rem |
| `--radius-sm` | 0.25rem |
| `--radius-md` | 0.375rem |
| `--radius-lg` | 0.5rem |
| `--radius-xl` | 0.75rem |
| `--radius-pill` | 999px |
| `--radius-full` | 9999px |
| `--shadow-sm` | 0 1px 2px rgb(0 0 0 / 0.05) |
| `--shadow-md` | 0 4px 6px rgb(0 0 0 / 0.08) |
| `--shadow-lg` | 0 10px 15px rgb(0 0 0 / 0.1) |
| `--shadow-xl` | 0 20px 25px rgb(0 0 0 / 0.12) |
| `--shadow-2xl` | 0 25px 50px rgb(0 0 0 / 0.2) |
| `--duration-fast` | 150ms |
| `--duration-normal` | 250ms |
| `--duration-slow` | 450ms |
| `--ease-default` | cubic-bezier(0.4, 0, 0.2, 1) |
| `--ease-in` | cubic-bezier(0.4, 0, 1, 1) |
| `--ease-out` | cubic-bezier(0, 0, 0.2, 1) |
| `--ease-spring` | cubic-bezier(0.34, 1.56, 0.64, 1) |

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
