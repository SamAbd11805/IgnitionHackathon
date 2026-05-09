# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

This is a fork of **3DStreet** — a browser-based urban planning tool built on **A-Frame** + **three.js**. The fork adds an agent-based crime simulation (`Crime` tab in the editor) for an `IgnitionHackathon` project.

Upstream: https://github.com/3DStreet/3dstreet — License: AGPL-3.0 (code), CC BY-NC 4.0 (assets).

## Architecture

Multi-application monorepo with shared components:

1. **A-Frame Core** (`/src`) — vanilla JS, registers ~30 A-Frame components, asset system, scene utilities. Entry: `src/index.js` → bundle `dist/aframe-street-component.js`.
2. **React Editor** (`/src/editor`) — Inspector-style UI mounted by `Inspector` class in `src/editor/index.jsx` into a `#aframeInspector` div appended to `<body>`. Communicates with A-Frame via `AFRAME.INSPECTOR.execute(...)`, `Events.emit(...)`, and direct DOM `setAttribute`.
3. **Generator** (`/src/generator`) — separate vanilla-JS app at `/generator/` with React islands for AI image/video generation (fal.ai + Replicate via Firebase proxy). Bundle: `dist/generator.js`.
4. **Bollard Buddy** (`/src/bollardbuddy`) — companion AR app. Bundle: `dist/bollardbuddy.js`.
5. **Shared** (`/src/shared`) — auth, navigation, Firebase services, used by editor + generator. Imported via webpack alias `@shared/*`.
6. **Firebase backend** (`/public/functions`) — Cloud Functions (auth, scenes CRUD, Stripe, AI proxies).

The fork adds a **5th bundle** `dist/crime-sim.js` (entry: `src/crime-sim.js`) — a lightweight bundle with street components + simulation, **without** the React editor. Used by `crime-demo.html` for standalone demo pages.

## Development commands

```bash
npm install                    # one-time install
npm start                      # webpack dev server on http://localhost:3333 (editor + /generator/)
npm run dist                   # production build
npm run dist:staging           # staging build (DEPLOY_ENV=development)
npm test                       # runs test:core + test:modern
npm run test:core              # mocha (legacy)
npm run test:modern            # vitest (preferred; *.test.js under test/)
npm run test:modern:watch      # vitest watch mode
npm run lint                   # eslint src/
npm run lint:fix               # eslint --fix
npm run prettier               # format src/
npm run storybook              # storybook on :6006
npm run emulator               # firebase emulators (requires staging build)
npm run deploy                 # production firebase deploy
```

**Pre-commit hook (husky + lint-staged):** runs prettier and eslint on staged `*.{js,jsx,scss}` files. ESLint failures abort the commit; fix them rather than bypassing with `--no-verify`. Prettier rewrites your staged files automatically.

**Webpack entries** are defined in `webpack.config.js`. Adding a new bundle means adding to the `entry` map and restarting the dev server (HMR does not pick up new entries).

**Environment:** dev server reads `config/.env.development`. The file is git-ignored and must be created locally with Firebase + API keys.

## Key A-Frame components (`src/aframe-components/`)

**Streets — preference order matters here:**
- `managed-street` — **preferred** for all new code. Manages `street-segment` children, loads from `streetmix-url`, `streetplan-url`, or `json-blob`.
- `street` + `streetmix-loader` — **legacy**, being phased out. Still used by `index.html`.
- `street-segment` — individual lane (drive-lane, bike-lane, sidewalk, etc.).
- `intersection` — 4-way intersection (no managed equivalent yet).

**Procedural population:** `street-generated-pedestrians`, `street-generated-clones`, `street-generated-striping`, `street-generated-stencil`, `street-generated-rail`. All use seeded RNG (`src/lib/rng`) for deterministic placement. Triggered by `segment-changed` events.

**Geospatial:** `street-geo`, `google-maps-aerial` (3D Tiles via `3d-tiles-renderer`), `geojson`.

**Utilities:** `gltf-part` (extracts named meshes from a GLB; the way human characters work — see `char1` mixins extracting `Character_1` from `humans` GLB), `create-from-json`, `screentock` (screenshots), `measure-line`, `css2d-renderer`.

**Component lifecycle docs:** `src/aframe-components/README.md` documents the event flow.

## Editor architecture (React)

`Inspector` (in `src/editor/index.jsx`) waits for `AFRAME.scenes[0]` to load, then mounts `<MainWrapper>` into a `#aframeInspector` div.

**Layout:** `Main` → `SceneGraph` (left, with Layers/Geospatial/Gallery/**Crime** tabs) + `RightPanel` (right, Properties/Console tabs) + `Viewport` overlays + `PrimaryToolbar` + `Modals`.

**State:** `src/store.js` — Zustand store. Holds modal state, panel visibility, scene metadata, save state, `rightPanelTab`, etc. Left-panel `activeTab` is **local React state** in `SceneGraph.jsx` (not Zustand) — different from the right panel.

**Mutations to A-Frame must go through commands** for undo/redo support: `AFRAME.INSPECTOR.execute('entitycreate', { mixin, components, ... })`. Direct `setAttribute` works but bypasses history.

**Layer drag-and-drop reorder** uses `EntityReparentCommand`, which serializes via `STREET.utils.getElementData()` and recreates via `STREET.utils.createEntityFromObj()` — same code path as save/load to avoid divergence bugs.

**Adding a left-panel tab:** edit the `tabs={[...]}` array in `src/editor/components/scenegraph/SceneGraph.jsx` (around line 506) + the conditional render below it. The Crime tab is the example — see `CrimeSimPanel.jsx` next to it.

## Asset system

`<street-assets>` custom element auto-injects A-Frame mixins from `src/catalog.json` and legacy hardcoded mixins in `src/assets.js` into the scene's `<a-assets>` block.

- **Mixin lookup is case-sensitive** — use IDs exactly as in catalog.json.
- **Animated character mixins** (`a_char1`–`a_char8`) load separate per-character GLBs with skeletal `walk` animations via `animation-mixer`. Static character poses (`char1`–`char16`) use `gltf-part` to extract `Character_N` from shared GLBs.
- **Vehicle "rig" mixins** (`sedan-rig`, `suv-rig`, `box-truck-rig`, etc.) include named wheel meshes (`wheel_F_L`, `wheel_F_R`, `wheel_B_L`, `wheel_B_R`) for the `wheel` component to animate.
- **Buildings catalog** uses `baseRotation: 180` on most entries because the GLBs face inward; `street-generated-clones` applies this automatically.
- **Catalog browser:** `STREET.catalog` is the global runtime array. Asset utilities source: https://github.com/3dstreet/3dstreet-assets-dist.

## Cross-application patterns

**A-Frame ↔ React channel:** Three flavors, in increasing order of "correctness":
1. Direct DOM (`entity.setAttribute`) — fast, no undo.
2. `Events.emit/on` — pub/sub for UI sync (e.g., `entityselect`, `entityupdate`).
3. `AFRAME.INSPECTOR.execute(commandName, payload)` — undoable mutation. Always use this for user-initiated changes.

**File naming:** A-Frame components are `kebab-case.js`. React components are `PascalCase.jsx`. Styles are `*.module.scss` (CSS modules) or plain `.scss`.

**Island architecture (generator app):** React components mount via `mount-*.js` files using `createRoot()` into specific DOM elements within a vanilla-JS shell.

**`@shared/*` imports:** webpack alias to `src/shared/`, with barrel exports. Example: `import { ProfileButton } from '@shared/auth/components'`.

**URL hash schemes** (handled by `set-loader-from-hash`):
- Streetmix URL: `#streetmix:...`
- StreetPlan URL: `#streetplan:...`
- Cloud scene UUID: `#scenes/<uuid>`
- Inline managed-street JSON: `#json:...`

## Crime simulation (this fork)

**Files added:**
- `src/aframe-components/city-simulation.js` — three components: `citizen-agent`, `police-agent`, `city-simulation` (orchestrator + city spawner).
- `src/editor/components/scenegraph/CrimeSimPanel.jsx` — React tab panel (live stats, sliders, controls).
- `src/crime-sim.js` — lightweight webpack entry (street components + simulation, no editor).
- `crime-demo.html` — standalone demo page using `dist/crime-sim.js` (avoids editor mounting errors).

**How the simulation runs in the editor:** the user clicks "Start" in the Crime tab → `CrimeSimPanel` creates an `<a-entity id="crime-sim-root" city-simulation="...">` and appends it to the scene. The `init` of `city-simulation` checks `sceneEl.hasLoaded` (since the editor's scene is already loaded by the time the panel runs) and immediately calls `_spawn()`, which spawns the city visuals + agents. All spawned entities are tagged with class `crime-sim-spawned` so "Stop" can clean them up via `document.querySelectorAll('.crime-sim-spawned').forEach(el => el.remove())`.

**Movement model:**
- `citizen-agent` walks a sidewalk graph (built procedurally in `buildSidewalkGraph()`: 4 intersection corners + 4×4 sidewalk arm nodes + 4 crosswalks). Movement is node-to-node, picking a random non-backtracking neighbor at each junction.
- `police-agent` follows lane waypoints from `POLICE_ROUTES` (right-hand drive). When responding to a crime, it switches to a 2-stage behavior: drive at 1.8× speed to `nearestRoadApproachPoint(crime)` (projects the crime onto the closest road lane), then approach off-road at 0.6× speed.

**Communication:** `city-simulation` broadcasts stats via `window.dispatchEvent(new CustomEvent('city-stats', { detail }))` and crime events via `sceneEl.emit('city-crime', ...)`. The React panel listens to both.

**Building the simulation bundle:** the `crimesim` entry in `webpack.config.js` is what the demo HTML uses. Modifying it requires a dev server restart.

## Tech stack

A-Frame master build (commit `6a054e8`, loaded via CDN in `index.html` for Three.js r181 compatibility with the Spark splat library), Three.js r181, React 18.2.0, Zustand 5.0.1, Firebase 11.10.0, Webpack 5.91.0, TailwindCSS 3.4.14, Mocha + Vitest for tests, Storybook 8.x.

## Key external integrations

**Streetmix / StreetPlan:** 2D street cross-sections imported via API → A-Frame entities (`streetmix-loader`, `street-mapping-streetplan`). Not all Streetmix segment types are supported — see README's compatibility table.

**Google 3D Tiles:** real-world geographic context via `google-maps-aerial` component using `3d-tiles-renderer`.

**fal.ai / Replicate:** image/video generation through Firebase Cloud Functions (`generateFalImage`, `generateReplicateImage`) — proxied to keep API keys server-side.

**Stripe:** token purchase flow (`createStripeSession`, `stripeWebhook`) feeding the generator's token system.

**PostHog + Sentry:** analytics and error tracking.
