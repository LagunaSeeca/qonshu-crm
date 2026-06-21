# Qonshu CRM — Design System (source of truth)

**Direction:** Clean modern SaaS (Linear / Vercel / Notion feel). Flat, minimal, lots of whitespace, subtle borders, restrained shadows. Light + dark. Built on **shadcn/ui** + Tailwind. Icons: **lucide-react** (no emoji). Font: **Plus Jakarta Sans** (headings + body) via `next/font`.

## Color tokens (HSL → shadcn CSS variables)
Map these into `globals.css` as shadcn `--background/--foreground/...` variables (light + `.dark`). Source hexes:

| Role | Light | Notes |
|------|-------|-------|
| primary | `#0F172A` (slate-900) | brand navy; primary buttons |
| primary-foreground | `#FFFFFF` | |
| accent / ring | `#0369A1` (sky-700) | links, focus ring, active nav |
| background | `#F8FAFC` (slate-50) | app canvas |
| card / popover | `#FFFFFF` | surfaces |
| foreground | `#020617` (slate-950) | body text |
| muted | `#E8ECF1` | subtle fills |
| muted-foreground | `#64748B` (slate-500) | secondary text |
| border / input | `#E2E8F0` (slate-200) | |
| destructive | `#DC2626` | delete/errors |
| success | `#16A34A` | won/positive |
| warning | `#D97706` | overdue/at-risk |

**Dark mode** (`.dark`): background `#0B1120`, card `#0F172A`, foreground `#E2E8F0`, muted-foreground `#94A3B8`, border `#1E293B`, primary becomes a light surface accent; keep accent sky-500 `#0EA5E9` for contrast. Verify 4.5:1 text contrast in BOTH modes.

## Stage / priority semantic colors (badges)
- Stage type: OPEN → slate/blue, WON → success green, LOST → destructive red.
- Priority: LOW → slate, MEDIUM → blue, HIGH → amber/warning.
Always pair color with text (never color-only).

## Typography
- Plus Jakarta Sans. Scale: 12 / 14 / 16(base) / 18 / 20 / 24 / 30. Line-height 1.5 body. Weights: 700 headings, 600 subheads/labels, 400 body, 500 nav/buttons. Tabular figures for money/counts.

## Effects & motion
- Radius: `--radius: 0.5rem`. Shadows: subtle only (`shadow-sm` on cards/popovers; no heavy drop shadows). Transitions 150–200ms ease for hover/state. Respect `prefers-reduced-motion`. cursor-pointer on all clickables. Visible focus ring (accent).

## App shell (all authenticated tenant pages)
- **Left sidebar** (~240px, collapsible on mobile): brand wordmark "Qonshu" top; nav items with lucide icon + label + active state (accent left-border/bg); items = Dashboard, Sales CRM, Accounts, Analytics, and (admin) Users; bottom: company name + role chip.
- **Top bar**: current page title/breadcrumb left; right = search (where relevant), theme toggle (sun/moon), user menu (avatar → name, email, Sign out).
- **Content**: `max-w-7xl`, padding `p-6`, section spacing 24/32. Page header pattern: title + optional primary action button (one primary CTA per page).
- Platform (super-admin) area gets a simpler shell (brand + Companies nav + user menu).

## Component conventions (shadcn/ui)
Use: `button`, `card`, `input`, `textarea`, `label`, `select`, `table`, `badge`, `dialog`, `dropdown-menu`, `avatar`, `separator`, `tabs`, `sonner` (toasts), `skeleton`. 
- Buttons: primary (navy), secondary (outline), ghost (nav/icon), destructive (delete). Loading → disabled + spinner.
- Forms: visible `<Label>`, error text below field (destructive), required `*`. Use sonner toasts for action success/failure (replaces the raw alert()/inline `<p>` error patterns added in M2).
- Tables: shadcn table; right-align money (tabular), badges for stage/priority, row hover, clickable row → detail.
- Empty states: icon + message + primary action (e.g. "No leads yet — Create lead").

## Per-screen notes
- **Login**: centered Card, brand, email/password, error toast, single primary button.
- **Dashboard**: page header + grid of stat Cards (placeholders now: # leads, pipeline value, won this month, open tasks) + an empty-state hint that richer analytics arrive in a later milestone.
- **Sales CRM board** (`/crm`): toolbar (view switch Board/List, New Lead, search); horizontal scroll columns per stage; column header = name + count + weighted total badge; cards = title, contact, value (tabular), priority badge; drag via dnd-kit; failure → toast.
- **Leads list** (`/crm/list`): filters bar (stage/owner/search) + shadcn table; New Lead via Dialog.
- **Lead detail** (`/crm/[id]`): two-column — left Card with editable fields + stage select; right Tabs (Activity / Tasks / Files). Activity timeline with icons per kind; tasks with checkboxes + overdue badge; files list + upload button. Save via toast.
- **Stage settings** (`/crm/stages`): Card with sortable stage rows (drag or up/down), inline edit name/type/probability, add row, delete (409 → toast "move leads first"), and the "Share all leads" switch (shadcn `switch`).
- **Users admin** (`/users`): table of users + role/status badges + invite Dialog + activate/deactivate.
- **Platform company-create** (`/platform/companies`): centered Card form.

## Hard rules (from UX guidelines)
- Contrast ≥4.5:1 (both themes); visible focus rings; keyboard nav; aria-labels on icon-only buttons; one primary CTA per screen; no emoji icons; reserve space (no layout shift); 150–300ms transitions; reduced-motion respected; existing component TESTS must stay green (preserve the text/labels they assert).
