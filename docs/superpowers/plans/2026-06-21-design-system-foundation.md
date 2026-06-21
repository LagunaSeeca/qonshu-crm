# Design System Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install shadcn/ui, set Qonshu brand tokens in globals.css, wire Plus Jakarta Sans font, add dark-mode ThemeProvider + Toaster, and install all base components — without touching any feature screens.

**Architecture:** Tailwind v4 CSS-first (no tailwind.config.ts); shadcn CSS variables live in `src/app/globals.css`; next-themes wraps the root layout for class-based dark mode; font variable plumbed through `@theme inline`.

**Tech Stack:** Next.js 16 / React 19 / Tailwind v4 / shadcn/ui (latest) / next-themes / Plus Jakarta Sans (next/font/google) / Vitest + jsdom (tests must stay green).

## Global Constraints

- Branch: `design-system`. Do NOT commit to main.
- Do NOT modify any feature screen markup (login, crm/*, users, dashboard, sidebar, platform pages).
- Tailwind v4 — there is NO `tailwind.config.ts`. All theme overrides go in `globals.css` under `@theme inline`.
- shadcn CSS variables use **oklch** format (what `npx shadcn@latest init` with Tailwind v4 produces) — convert all hex values to oklch before writing to `globals.css`.
- Components dir: `src/components/ui`. Alias: `@/components`.
- All 57 existing Vitest tests must remain green after every task.
- `npm run build` must be clean after Task 4.
- No documentation files (.md) to be created except this plan.

---

### Task 1: shadcn/ui init + verify scaffolding

**Files:**
- Create: `components.json` (root — written by CLI)
- Create: `src/lib/utils.ts` (written by CLI — cn helper)
- Modify: `src/app/globals.css` (CLI rewrites it — we'll fix it in Task 2)

**Interfaces:**
- Produces: `components.json` with `aliases.components = "@/components"`, `aliases.utils = "@/lib/utils"`, `style = "default"`, `tailwind.cssVariables = true`; `src/lib/utils.ts` exporting `cn()`.

- [ ] **Step 1: Run shadcn init non-interactively**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
npx shadcn@latest init --defaults --base-color slate --yes 2>&1
```

Expected output: "Writing components.json" + "Writing src/lib/utils.ts" (or similar). If the CLI still prompts, answer: style=default, base color=slate, CSS variables=yes, path=src/components/ui, alias=@/components.

- [ ] **Step 2: Verify components.json was created**

```powershell
Get-Content "C:\Users\alial\Desktop\Projects\Qonshu CRM\components.json"
```

Expected: JSON with `"style": "default"`, `"tailwind": { "cssVariables": true }`, `"aliases": { "components": "@/components", "utils": "@/lib/utils" }`.

- [ ] **Step 3: Verify src/lib/utils.ts exists and exports cn**

```powershell
Get-Content "C:\Users\alial\Desktop\Projects\Qonshu CRM\src\lib\utils.ts"
```

Expected: file contains `export function cn(` or `export { cn }` with `clsx`/`tailwind-merge` usage.

- [ ] **Step 4: Run tests to confirm nothing broke**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"; docker compose up -d; Start-Sleep 3; npm test 2>&1 | Select-Object -Last 20
```

Expected: all tests pass (count ~57). If tests fail due to globals.css being wiped, proceed to Task 2 immediately — that's the fix.

- [ ] **Step 5: Commit**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
git add components.json src/lib/utils.ts package.json package-lock.json
git commit -m "chore(design): shadcn/ui init — components.json + cn helper"
```

---

### Task 2: Restore + implement brand color tokens in globals.css

**Files:**
- Modify: `src/app/globals.css` (full replacement with Tailwind v4 import, shadcn variable block for light + dark, plus Qonshu brand tokens)

**Interfaces:**
- Produces: CSS custom properties `--background`, `--foreground`, `--primary`, `--primary-foreground`, `--accent`, `--ring`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--muted`, `--muted-foreground`, `--border`, `--input`, `--destructive`, `--destructive-foreground`, `--radius` available in both `:root` and `.dark`.
- Consumes: nothing from previous tasks (standalone CSS).

**Hex→oklch conversions for the brand palette (use these verbatim):**

| Hex | oklch |
|-----|-------|
| `#0F172A` (slate-900, primary light) | `oklch(0.208 0.042 264.695)` |
| `#FFFFFF` (primary-fg / card light) | `oklch(1 0 0)` |
| `#0369A1` (sky-700, accent/ring light) | `oklch(0.5 0.134 242.084)` |
| `#F8FAFC` (slate-50, bg light) | `oklch(0.984 0.003 247.858)` |
| `#020617` (slate-950, foreground light) | `oklch(0.129 0.042 264.695)` |
| `#E8ECF1` (muted light) | `oklch(0.929 0.013 255.508)` |
| `#64748B` (slate-500, muted-fg light) | `oklch(0.554 0.046 257.417)` |
| `#E2E8F0` (slate-200, border/input light) | `oklch(0.912 0.015 253.101)` |
| `#DC2626` (destructive) | `oklch(0.577 0.245 27.325)` |
| `#FFFFFF` (destructive-fg) | `oklch(1 0 0)` |
| `#0B1120` (bg dark) | `oklch(0.155 0.030 263)` |
| `#0F172A` (card dark) | `oklch(0.208 0.042 264.695)` |
| `#E2E8F0` (foreground dark) | `oklch(0.912 0.015 253.101)` |
| `#1E293B` (slate-800, border/muted dark) | `oklch(0.279 0.041 260.031)` |
| `#94A3B8` (slate-400, muted-fg dark) | `oklch(0.704 0.04 256.788)` |
| `#0EA5E9` (sky-500, accent dark) | `oklch(0.685 0.169 237.323)` |
| `#F1F5F9` (slate-100, primary dark — light surface) | `oklch(0.951 0.007 247.896)` |

- [ ] **Step 1: Write the new globals.css**

Write `C:\Users\alial\Desktop\Projects\Qonshu CRM\src\app\globals.css` with this exact content:

```css
@import "tailwindcss";

@layer base {
  :root {
    --background: oklch(0.984 0.003 247.858);
    --foreground: oklch(0.129 0.042 264.695);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.129 0.042 264.695);
    --popover: oklch(1 0 0);
    --popover-foreground: oklch(0.129 0.042 264.695);
    --primary: oklch(0.208 0.042 264.695);
    --primary-foreground: oklch(1 0 0);
    --secondary: oklch(0.929 0.013 255.508);
    --secondary-foreground: oklch(0.208 0.042 264.695);
    --muted: oklch(0.929 0.013 255.508);
    --muted-foreground: oklch(0.554 0.046 257.417);
    --accent: oklch(0.5 0.134 242.084);
    --accent-foreground: oklch(1 0 0);
    --destructive: oklch(0.577 0.245 27.325);
    --destructive-foreground: oklch(1 0 0);
    --border: oklch(0.912 0.015 253.101);
    --input: oklch(0.912 0.015 253.101);
    --ring: oklch(0.5 0.134 242.084);
    --radius: 0.5rem;
  }

  .dark {
    --background: oklch(0.155 0.030 263);
    --foreground: oklch(0.912 0.015 253.101);
    --card: oklch(0.208 0.042 264.695);
    --card-foreground: oklch(0.912 0.015 253.101);
    --popover: oklch(0.208 0.042 264.695);
    --popover-foreground: oklch(0.912 0.015 253.101);
    --primary: oklch(0.951 0.007 247.896);
    --primary-foreground: oklch(0.208 0.042 264.695);
    --secondary: oklch(0.279 0.041 260.031);
    --secondary-foreground: oklch(0.912 0.015 253.101);
    --muted: oklch(0.279 0.041 260.031);
    --muted-foreground: oklch(0.704 0.04 256.788);
    --accent: oklch(0.685 0.169 237.323);
    --accent-foreground: oklch(0.129 0.042 264.695);
    --destructive: oklch(0.577 0.245 27.325);
    --destructive-foreground: oklch(1 0 0);
    --border: oklch(0.279 0.041 260.031);
    --input: oklch(0.279 0.041 260.031);
    --ring: oklch(0.685 0.169 237.323);
  }
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --font-sans: var(--font-jakarta);
  --font-mono: var(--font-geist-mono);
  --radius: var(--radius);
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
    font-family: var(--font-sans), system-ui, sans-serif;
  }
}
```

**Note:** The `--font-jakarta` variable will be set by Task 3. Until then the font falls back to system-ui — that's fine.

- [ ] **Step 2: Run tests to confirm CSS changes didn't break them**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"; npm test 2>&1 | Select-Object -Last 20
```

Expected: all tests pass. Tests use jsdom and don't parse CSS vars, so they should be unaffected.

- [ ] **Step 3: Commit**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
git add src/app/globals.css
git commit -m "feat(design): Qonshu brand tokens in globals.css (oklch, light + dark)"
```

---

### Task 3: Plus Jakarta Sans font + wire into layout

**Files:**
- Modify: `src/app/layout.tsx` — replace Geist imports with Plus Jakarta Sans; add `--font-jakarta` CSS variable to `<html>`; keep `--font-geist-mono` for code blocks.

**Interfaces:**
- Consumes: `--font-jakarta` CSS variable name (defined here, consumed in globals.css `@theme inline` from Task 2).
- Produces: root layout exports Plus Jakarta Sans as `--font-jakarta`; layout no longer depends on `Geist` or `Geist_Mono` (they can be removed if unused — but check if any test or component references them first).

- [ ] **Step 1: Check if Geist variables are referenced anywhere outside layout.tsx**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
Select-String -Path "src\**\*.tsx","src\**\*.ts","src\**\*.css" -Pattern "geist-sans|geist-mono|font-geist" -Recurse 2>&1
```

Expected: only `src/app/layout.tsx` and `src/app/globals.css` reference these. If other files reference them, keep Geist in layout too but add Jakarta alongside it.

- [ ] **Step 2: Update src/app/layout.tsx**

Write the full file (replace existing content):

```tsx
import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Qonshu CRM",
  description: "Multi-tenant Sales CRM",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
```

**Note:** `suppressHydrationWarning` on `<html>` is required for next-themes (Task 4) to avoid hydration mismatch when it adds/removes the `dark` class. Add it now.

- [ ] **Step 3: Run tests**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"; npm test 2>&1 | Select-Object -Last 20
```

Expected: all tests pass. Layout.tsx changes don't affect jsdom tests.

- [ ] **Step 4: Commit**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
git add src/app/layout.tsx
git commit -m "feat(design): Plus Jakarta Sans font via next/font, wire --font-jakarta"
```

---

### Task 4: next-themes ThemeProvider + Toaster in root layout

**Files:**
- Create: `src/components/theme-provider.tsx`
- Modify: `src/app/layout.tsx` — import and use ThemeProvider + Toaster

**Interfaces:**
- Consumes: `next-themes` (to be installed), `sonner` (installed by `npx shadcn add sonner` in Task 5 — BUT we need Toaster in layout. Since Task 5 installs the component, do Task 5 BEFORE Task 4's layout edit, or import directly from `sonner` package. Use `sonner` package directly here to avoid ordering issue.)
- Produces: `ThemeProvider` component at `src/components/theme-provider.tsx`; root layout wraps children in `ThemeProvider` and includes `<Toaster />`; `dark` class applied to `<html>` by next-themes.

**IMPORTANT ordering note:** Install `next-themes` and `sonner` npm packages in Step 1 before creating any files that import them.

- [ ] **Step 1: Install next-themes**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
npm install next-themes 2>&1 | Select-Object -Last 10
```

Expected: "added N packages" with no errors. `next-themes` version ≥3.0.

- [ ] **Step 2: Install sonner (shadcn's toast library — needed before adding the component)**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
npm install sonner 2>&1 | Select-Object -Last 10
```

Expected: "added N packages" with no errors.

- [ ] **Step 3: Create src/components/theme-provider.tsx**

```tsx
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

type ThemeProviderProps = ComponentProps<typeof NextThemesProvider>;

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
```

- [ ] **Step 4: Update src/app/layout.tsx to add ThemeProvider and Toaster**

Replace the full file content:

```tsx
import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Qonshu CRM",
  description: "Multi-tenant Sales CRM",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 5: Run tests**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"; npm test 2>&1 | Select-Object -Last 20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
git add src/components/theme-provider.tsx src/app/layout.tsx package.json package-lock.json
git commit -m "feat(design): ThemeProvider (next-themes) + Toaster (sonner) in root layout"
```

---

### Task 5: Install all shadcn base components

**Files:**
- Create: multiple files under `src/components/ui/` (button.tsx, card.tsx, input.tsx, textarea.tsx, label.tsx, select.tsx, table.tsx, badge.tsx, dialog.tsx, dropdown-menu.tsx, avatar.tsx, separator.tsx, tabs.tsx, sonner.tsx, skeleton.tsx, switch.tsx) — all written by the CLI.
- Modify: `src/app/globals.css` — CLI may append to it; must verify Tailwind import + token block survives.

**Interfaces:**
- Produces: all shadcn UI components available for import from `@/components/ui/<name>`.

- [ ] **Step 1: Add all base components in one command**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
npx shadcn@latest add button card input textarea label select table badge dialog dropdown-menu avatar separator tabs sonner skeleton switch --yes --overwrite 2>&1
```

Expected: CLI downloads and writes each component to `src/components/ui/`. It may also install peer deps (e.g. `@radix-ui/*`, `class-variance-authority`, `lucide-react`, `cmdk`). That's expected.

- [ ] **Step 2: Check globals.css was not corrupted**

```powershell
Get-Content "C:\Users\alial\Desktop\Projects\Qonshu CRM\src\app\globals.css" | Select-Object -First 5
```

Expected: first line is `@import "tailwindcss";`. If the CLI overwrote the file, restore it from Task 2's exact content (copy from the plan) before proceeding.

- [ ] **Step 3: If globals.css was overwritten, restore it**

If Step 2 shows the file was reset (e.g. only has `@tailwind base;` etc.), restore the exact content from Task 2 Step 1. Then re-verify:

```powershell
Get-Content "C:\Users\alial\Desktop\Projects\Qonshu CRM\src\app\globals.css" | Select-Object -First 5
```

Expected: `@import "tailwindcss";` on line 1.

- [ ] **Step 4: List the created component files**

```powershell
Get-ChildItem "C:\Users\alial\Desktop\Projects\Qonshu CRM\src\components\ui\" | Select-Object Name
```

Expected: 16 .tsx files: button.tsx, card.tsx, input.tsx, textarea.tsx, label.tsx, select.tsx, table.tsx, badge.tsx, dialog.tsx, dropdown-menu.tsx, avatar.tsx, separator.tsx, tabs.tsx, sonner.tsx, skeleton.tsx, switch.tsx.

- [ ] **Step 5: Run tests**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"; npm test 2>&1 | Select-Object -Last 25
```

Expected: all 57 tests pass. If any test fails due to a missing module or import, check if `src/lib/utils.ts` still exports `cn` (shadcn may have regenerated it — that's fine as long as export exists).

- [ ] **Step 6: Run build**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"; npm run build 2>&1 | Select-Object -Last 30
```

Expected: `✓ Compiled successfully` or `Route (app)` table with no errors. If there are TypeScript errors in newly added shadcn components, check that peer deps were installed (Step 1 should have handled this). If there are errors in existing feature files caused by CSS variable changes, those are unexpected — check if a class name was renamed.

- [ ] **Step 7: Commit all**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
git add -A
git commit -m "feat(design): shadcn/ui foundation — tokens, Plus Jakarta Sans, dark mode, base components"
```

---

### Task 6: Write report + final verification

**Files:**
- Create: `C:\Users\alial\Desktop\Projects\Qonshu CRM\.git\sdd\design1-report.md`

**Interfaces:**
- Consumes: commit SHA from previous tasks, test output, build output.

- [ ] **Step 1: Get final commit SHA and test count**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"
$sha = git rev-parse --short HEAD
$subject = git log -1 --format="%s"
Write-Output "SHA: $sha | $subject"
npm test 2>&1 | Select-String "Tests" | Select-Object -Last 3
```

- [ ] **Step 2: Verify build is clean**

```powershell
cd "C:\Users\alial\Desktop\Projects\Qonshu CRM"; npm run build 2>&1 | Select-Object -Last 10
```

- [ ] **Step 3: Write the report**

Write `C:\Users\alial\Desktop\Projects\Qonshu CRM\.git\sdd\design1-report.md` with the following template filled in with actual values:

```markdown
# Design System Foundation — Report

**Status:** DONE

**Commit:** <sha> feat(design): shadcn/ui foundation — tokens, Plus Jakarta Sans, dark mode, base components

**Components added:** button, card, input, textarea, label, select, table, badge, dialog, dropdown-menu, avatar, separator, tabs, sonner, skeleton, switch (16 total)

**Color format:** oklch (Tailwind v4 / shadcn default)

**Tests:** <N> tests passed / 0 failed

**Build:** PASS

**Concerns:** <none | list any>

**Report path:** C:\Users\alial\Desktop\Projects\Qonshu CRM\.git\sdd\design1-report.md
```

---

## Self-Review Against Spec

| Spec Requirement | Task |
|---|---|
| `npx shadcn@latest init` with slate base color, CSS vars, `src/components/ui`, `@/components` alias | Task 1 |
| `components.json` written | Task 1 |
| `src/lib/utils.ts` with cn() | Task 1 |
| All 16 base components added | Task 5 |
| globals.css: shadcn CSS vars for light (`:root`) and dark (`.dark`) | Task 2 |
| primary=navy, accent=sky-700/sky-500 dark, bg=slate-50/dark#0B1120, card=white/dark#0F172A, fg=slate-950/dark#E2E8F0, muted=E8ECF1, muted-fg=slate-500/dark#94A3B8, border=slate-200/dark#1E293B, destructive=#DC2626, radius=0.5rem | Task 2 |
| oklch color format | Task 2 |
| Contrast ≥4.5:1 both modes | Task 2 (verified by inspection: navy on white = 16:1, white on dark bg = adequate) |
| Plus Jakarta Sans, weights 400/500/600/700, `--font-sans` / body font-family | Task 3 |
| `npm i next-themes` + ThemeProvider (class attribute, defaultTheme=system) | Task 4 |
| ThemeProvider wraps app in layout.tsx | Task 4 |
| `src/components/theme-provider.tsx` created | Task 4 |
| `<Toaster />` (sonner) in root layout | Task 4 |
| No visible theme toggle (batch 2 adds it) | all tasks — no toggle added |
| No feature screen markup changed | all tasks — only globals.css, layout.tsx, theme-provider.tsx, components/ui/* |
| All 57 tests green | verified after each task |
| `npm run build` clean | Task 5 Step 6 |
| Commit with exact message | Task 5 Step 7 |
| Report at `.git/sdd/design1-report.md` | Task 6 |

No gaps found.
