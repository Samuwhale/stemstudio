# Design Principles

### Users
Solo users and power users use this app locally to split songs into stems, shape a usable mix, and export outcomes such as vocal-free instrumentals, backing-vocal versions, or instrument-reduced mixes.

Their sessions are task-oriented: import songs, queue processing, then spend most of their time reviewing results and shaping the winning split. They need to understand the current stage, the next action, and the active song at a glance.

### Brand Personality
Focused, confident, studio-utility.

The interface should feel calm, direct, and operational. It should reduce ambiguity, avoid ornamental chrome, and make state changes feel trustworthy rather than flashy.

### Aesthetic Direction
Industrial, restrained desktop audio tooling with the clarity of a focused local utility.

**Reference anchors:** LALAL.AI, Sesh.fm, and peers in the stem-split / collaborative-audio space. Borrow their focused task flow, dense-but-legible controls, and "one song, one workspace" hierarchy. Avoid their reflexes toward neon cyan/purple accents, glass cards, and marketing-page-dressed-as-app framing.

**Theme: support both, default to light.**
- Light is the default: a quiet green-gray utility palette (current `--bg: #f7faf8` family). It should feel calm, readable, and operational rather than decorative.
- Dark is a first-class companion for extended listening/mixing sessions. It should stay close to warm graphite, not pure black or generic slate-blue.

**Palette direction.** Use one restrained accent for primary actions and active state. The current accent is deep teal in light mode and pale mint in dark mode. Keep status colors distinct, functional, and sparse.

**Typography:**
- Display and body: system UI fonts. StemStudio should not depend on remote font requests for the local app experience.
- Mono: **Commit Mono** for timestamps, durations, gain values, hashes, and anything numeric that benefits from tabular alignment.
- Scale: fixed `rem` scale (app UI, not marketing). 5-step scale with ≥1.25 ratio; use weight and size contrast, not color, for hierarchy.

**Structural direction the product should borrow from DAWs and stem tools:**
- library / job views stay separate from the active song workspace
- the current-song page prioritizes playback, stem balance, and export
- advanced tools live behind clear secondary disclosures or contextual actions

**Explicit anti-patterns:** dashboard-like SaaS layouts, nested cards, decorative wrappers, redundant helper copy, informational pills that restate nearby text, gradient text, neon-on-black "AI app" aesthetics, colored left-border accent stripes, glassmorphism chrome, and any layout where setup, queue state, mixing, comparison, and maintenance all compete for equal visual weight.

### Design Principles
1. Put one primary job on screen at a time. The active song and its next action should dominate the right pane; browsing and queue management should stay secondary.
2. Make the mixer the main completed-state workspace. When a split is ready, the default view should emphasize listening, gain, mute or solo, final choice, and export.
3. Use progressive disclosure aggressively. Split setup, compare, notes, song maintenance, and cleanup should appear only when needed.
4. Reduce status to one clear explanation per state. Do not restate the same condition in multiple banners, headers, and summaries.
5. Optimize list views for scanning. Show title, stage, and the most useful next cue; remove explanatory clutter that slows comparison across songs.
6. Commit to one restrained accent and use it as a scarce resource. Everything else is neutral ink and quiet utility surfaces.
