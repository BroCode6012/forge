---
name: "YTA Empire WebGL"
description: "A dense Cut Ledger editing console for AI-assisted faceless YouTube production."
colors:
  primary: "#c6f36a"
  primary-hover: "#d3ff7a"
  primary-light: "rgba(198, 243, 106, 0.11)"
  accent: "#c6f36a"
  success: "#7ed69a"
  warning: "#ffb454"
  danger: "#ff756d"
  bg-dark: "#080a08"
  bg-primary: "#0e110f"
  bg-secondary: "#141815"
  bg-tertiary: "#1a1f1b"
  bg-hover: "#222820"
  panel-surface: "#101310"
  control-surface: "#171b18"
  recessed-surface: "#0c0f0d"
  monitor-surface: "#030403"
  track-surface: "#090b09"
  active-surface: "#202a19"
  clip-surface: "#26321f"
  clip-selected: "#334326"
  text-primary: "#e6eadf"
  text-secondary: "#aeb5a9"
  text-muted: "#777f75"
  ink-on-accent: "#11160e"
  border: "#293029"
  border-light: "#384238"
  focus-border: "#8aac53"
typography:
  brand:
    fontFamily: '"YTA Condensed", sans-serif'
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.035em"
  section:
    fontFamily: '"YTA Condensed", sans-serif'
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
  body:
    fontFamily: '"YTA Source", "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.005em"
  control:
    fontFamily: '"YTA Source", "Segoe UI", sans-serif'
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  field:
    fontFamily: '"YTA Source", "Segoe UI", sans-serif'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: '"YTA Condensed", sans-serif'
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.09em"
  tab:
    fontFamily: '"YTA Source", "Segoe UI", sans-serif'
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  badge:
    fontFamily: '"YTA Source", "Segoe UI", sans-serif'
    fontSize: "9px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.04em"
  timecode:
    fontFamily: "Consolas, monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0"
rounded:
  clip: "4px"
  sm: "5px"
  card: "7px"
  md: "8px"
  lg: "10px"
  pill: "999px"
spacing:
  "2xs": "4px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  "2xl": "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.ink-on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.ink-on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
    height: "32px"
  field:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.field}"
    rounded: "{rounded.sm}"
    padding: "6px 9px"
    height: "32px"
  settings-tab-active:
    backgroundColor: "{colors.active-surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.tab}"
    rounded: "4px 4px 0 0"
    padding: "6px 4px"
    height: "33px"
  mode-badge:
    backgroundColor: "{colors.active-surface}"
    textColor: "{colors.primary-hover}"
    typography: "{typography.badge}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
    height: "19px"
  drop-zone:
    backgroundColor: "{colors.recessed-surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.field}"
    rounded: "{rounded.card}"
    padding: "16px 12px"
    height: "100px"
  scene-card-active:
    backgroundColor: "{colors.active-surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.field}"
    rounded: "6px"
    padding: "9px 10px"
  timeline-clip-selected:
    backgroundColor: "{colors.clip-selected}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.clip}"
    padding: "0 8px"
  agent-composer:
    backgroundColor: "#151915"
    textColor: "{colors.text-primary}"
    typography: "{typography.field}"
    rounded: "{rounded.card}"
  progress:
    backgroundColor: "#111511"
    textColor: "{colors.text-secondary}"
    typography: "{typography.field}"
    rounded: "{rounded.card}"
    padding: "16px"
---

# Design System: YTA Empire WebGL

## Overview

**Creative North Star: "Cut Ledger"**

Cut Ledger treats YTA Empire as an edit decision ledger rather than a generic dashboard. Matte carbon bays frame a dominant program monitor; warm paper text, ruled timecode, and sharply divided tracks make automation legible as an editing process.

The interface is dense, restrained, and operational. Lime is reserved for selection and primary action, amber marks processing and the current time, and quiet carbon layers preserve context across import, build, inspection, refinement, and render.

The independent finish review disposition is **PASS** across THESIS, OWN-WORLD, STORY, FIRST VIEWPORT, and FORM.

**Key Characteristics:**

- Matte carbon editing-console surfaces with warm paper text.
- Condensed uppercase bay labels paired with compact humanist body copy.
- Ruled timecode, fixed track labels, and 80px timeline divisions.
- Lime selection and primary actions; amber processing and playhead states.
- Tight desktop density with shallow radii, hairline borders, and selective structural shadow.

## Colors

The palette is a carbon-and-paper neutral system animated by one lime action signal and tightly scoped status colors.

### Primary

- **Selection Lime** (`colors.primary`): selected tabs, selected clips, primary actions, focus outlines, checked controls, and the import-card ledger mark.
- **Action Lime** (`colors.primary-hover`): hover state for primary actions.
- **Lime Wash** (`colors.primary-light`): restrained tint for selected or emphasized surfaces.

### Secondary

- **Processing Amber** (`colors.warning`): build progress, agent progress, and the timeline playhead.
- **Signal Green** (`colors.success`): healthy monitor and agent status.
- **Fault Coral** (`colors.danger`): destructive and error states.

### Neutral

- **Matte Carbon** (`colors.bg-dark`): application and outer workspace ground.
- **Console Carbon** (`colors.panel-surface`): studio bar and side bays.
- **Recessed Carbon** (`colors.recessed-surface`): tab rails and import wells.
- **Program Black** (`colors.monitor-surface`): program-monitor frame.
- **Track Black** (`colors.track-surface`): ruled timeline field.
- **Warm Paper** (`colors.text-primary`): highest-emphasis interface text.
- **Secondary Paper** (`colors.text-secondary`): standard labels and supporting copy.
- **Muted Ledger** (`colors.text-muted`): hints, inactive labels, and empty states.
- **Ruled Divider** (`colors.border`): panel, row, and section separation.
- **Raised Rule** (`colors.border-light`): controls and stronger boundaries.

### Named Rules

**The Signal Hierarchy Rule.** Lime means selection and primary action; amber means processing or current time; green means healthy status; coral means fault or destructive state.

**The Matte Majority Rule.** Carbon surfaces dominate every viewport; accent colors stay local to state, selection, and action.

## Typography

**Display Font:** YTA Condensed (sans-serif fallback)  
**Body Font:** YTA Source (Segoe UI, sans-serif fallback)  
**Label/Mono Font:** Consolas (monospace fallback)

**Character:** Condensed type labels the physical editing bays and creates a technical ledger rhythm. YTA Source carries controls and explanatory copy, while Consolas isolates timecode and machine readouts.

### Hierarchy

- **Brand** (`typography.brand`): uppercase studio identity in the top bar.
- **Section** (`typography.section`): uppercase panel and bay headings.
- **Body** (`typography.body`): default application copy.
- **Control** (`typography.control`): compact buttons and high-emphasis control labels.
- **Field** (`typography.field`): inputs, scene copy, and agent composition.
- **Label** (`typography.label`): track names, toolbar labels, and technical metadata.
- **Tab** (`typography.tab`): settings and inspector navigation.
- **Badge** (`typography.badge`): compact uppercase production-mode status.
- **Timecode** (`typography.timecode`): duration, monitor readouts, and timeline values.

### Named Rules

**The Three-Voice Rule.** Condensed names the workspace, Source explains and controls it, and Consolas reports time or machine state.

## Layout

The application is a fixed-height desktop editing console. A 54px studio bar sits above a three-bay main workspace: 326px left settings bay, flexible central program monitor, and 326px right inspector/agent bay. The timeline remains visible below with a minimum height of 180px, 112px fixed track labels, and ruled 80px divisions.

Panel sections use edge-to-edge stacking with 13px by 14px internal padding and 1px dividers. The central preview uses 16px horizontal stage padding, a 42px stage bar, and a monitor that absorbs the remaining space.

At **1260px**, the header tightens, the project label disappears, the renderer control narrows to 160px, and side bays contract to 294px and 286px. At **1020px**, the brand edition, refresh action, and renderer control are hidden; side bays contract to 270px and 260px, and preview padding narrows to 10px. The shipped system compresses a professional desktop workspace; it does not introduce a mobile single-column mode.

**The Context-Preservation Rule.** Responsive changes remove secondary header information before hiding editing state, the monitor, inspector, or timeline.

## Elevation & Depth

Depth is structural, not decorative. Most surfaces stay flat and separate through carbon tone changes and 1px rules; shadows are reserved for the studio bar, program monitor, timeline edge, agent composer, and floating menus.

### Shadow Vocabulary

- **Root elevation** (`0 18px 42px rgba(0, 0, 0, 0.38)`): shared elevated media-frame shadow.
- **Studio bar** (`0 7px 24px rgba(0, 0, 0, 0.24)`): separates global controls from the workspace.
- **Program monitor** (`0 20px 48px rgba(0, 0, 0, 0.32)`): gives the central viewing surface physical priority.
- **Timeline lift** (`0 -12px 28px rgba(0, 0, 0, 0.24)`): separates the ledger from the bays above.
- **Agent composer** (`0 12px 28px rgba(0, 0, 0, 0.24)`): lifts the active command surface.
- **Floating menu** (`0 18px 48px rgba(0, 0, 0, 0.52)`): highest ambient shadow for transient overlays.
- **Focus halo** (`0 0 0 2px rgba(198, 243, 106, 0.08)`): restrained lime confirmation around the active composer.

**The Flat-Until-Needed Rule.** Panels, cards, and clips are flat at rest; shadow appears only when a surface must separate spatially or capture active input.

## Shapes

The form language is compact and machined: 4px clips, 5px controls, 7px compact cards, 8px media frames, and 10px large containers. Tabs use squared lower corners to lock into their rails, while status dots and compact badges are the only consistently circular forms. Dashed import borders, hairline panel rules, monitor corner marks, and the 1px amber playhead reinforce the ledger geometry.

**The Shallow-Corner Rule.** Keep operational surfaces between 4px and 10px; reserve pills and circles for badges, status, and icon-only controls.

## Components

### Buttons

Buttons are compact, high-contrast controls with no decorative lift.

- **Shape:** shallow control corners (`rounded.sm`) and a 32px minimum height.
- **Primary:** Selection Lime with dark ink; the top-bar render action is at least 108px wide.
- **Secondary:** control carbon with a raised-rule border and secondary paper text.
- **Hover / Focus:** primary shifts to Action Lime; secondary brightens its border and surface; keyboard focus uses a 2px lime outline with 2px offset.
- **Motion:** state changes use 170ms `cubic-bezier(0.22, 1, 0.36, 1)` without hover translation in the redesigned toolbar.

### Chips

- **Mode badge:** a compact uppercase pill using active carbon, a muted olive border, and pale lime text.
- **Source toggle:** a 5px-radius outlined chip; checked state changes the border and surface to olive-lime tones while the checkbox uses Selection Lime.

### Cards / Containers

- **Drop zone:** recessed carbon, a 1px dashed border, 7px corners, and 16px by 12px padding; hover changes the rule to Selection Lime.
- **Scene card:** flat 6px card with a ruled border; active state uses active carbon, a lime border, and a subtle inset lime keyline.
- **Program monitor:** black 8px frame with registration-like corner marks and the program-monitor shadow.
- **Panel sections:** edge-to-edge, square, transparent containers divided by 1px rules rather than floating cards.

### Inputs / Fields

- **Style:** 32px minimum height, 5px corners, 1px raised-rule border, control carbon, warm paper text, and 6px by 9px padding.
- **Hover:** border strengthens without changing geometry.
- **Focus:** border becomes the olive-lime focus border and the field surface lightens.
- **Disabled:** muted text and border on a darker carbon surface; opacity remains stable.

### Navigation

Settings and inspector navigation use rail-mounted tabs. Labels are compact and bold; inactive tabs are muted on transparent or recessed carbon, hover adds a quiet carbon fill, and active tabs combine a lime bottom rule with active carbon and pale lime text.

### Timeline Ledger

Track labels are fixed at 112px and use condensed uppercase labels. Track content carries 80px vertical rules. Clips are 4px carbon-olive blocks; selected clips use a lime border, brighter olive surface, and a 1px lime keyline. The current-time playhead is a single amber pixel with an amber marker.

### Agent Composer

The composer is a 7px carbon command well with an ambient shadow. Focus-within changes the border to olive-lime and adds the restrained focus halo. Its 30px square send control uses Selection Lime, dark ink, and the same 5px control corner as the rest of the console.

**The State-Before-Decoration Rule.** Every accent, border shift, and shadow must communicate selection, progress, health, error, hierarchy, or input focus.

## Do's and Don'ts

### Do:

- **Do** keep Matte Carbon, Console Carbon, and Track Black as the visual majority.
- **Do** use Selection Lime for the active edit target, primary action, checked control, and keyboard focus.
- **Do** use Processing Amber for build progress, agent progress, and the current-time playhead.
- **Do** preserve the dominant program monitor, visible side bays, and ruled timeline in desktop layouts.
- **Do** use condensed uppercase labels for bays, tracks, and technical toolbar metadata.

### Don't:

- **Don't** reintroduce purple gradients, neon dashboard glows, or generic SaaS-card styling into the editor shell.
- **Don't** use lime and amber interchangeably; they encode different operational states.
- **Don't** float every section as a rounded card; panel structure comes from edge-to-edge stacking and hairline rules.
- **Don't** hide essential editing context merely to simplify a narrower desktop viewport.
- **Don't** add marketing claims, decorative data, or interface states that are not supported by the product.
