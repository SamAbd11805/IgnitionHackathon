/* global THREE */
/* demo/index.jsx
 * Standalone pitch-demo app. Mounts on top of a tiny <a-scene> in demo.html.
 * Reuses the existing MayorChatPanel from the editor as-is (no fork).
 *
 * Flow:
 *   1) CityPicker overlay — user picks EPFL / Lausanne / Manhattan / Paris.
 *   2) DemoView builds the OSM city, then shows: HUD (top-left),
 *      Focus menu (bottom-left), and the AI Mayor (right side).
 *
 * Sim → IRL time mapping: 1 sim-second = 1 IRL-minute. avgResponseMs is
 * already in real ms; (ms / 1000) gives sim-seconds, which we LABEL as
 * minutes in the HUD ("4.2 min").
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import MayorChatPanel from '../editor/components/scenegraph/MayorChatPanel';

const SIM_ENTITY_ID = 'crime-sim-root';
// Same class city-simulation uses to tag everything it spawns; tagging our
// own marker entities with it lets wipeSim() / city rebuild clean them up.
const SPAWN_CLASS = 'crime-sim-spawned';

const ROUTE_COLORS = [
  '#00ffff',
  '#ff00ff',
  '#ffee00',
  '#ff6600',
  '#00ff66',
  '#ff0066',
  '#9966ff',
  '#66ffff',
  '#ff44aa',
  '#44ff44',
  '#ffaa44',
  '#44aaff',
  '#ff8866',
  '#88ff88',
  '#cc66ff',
  '#ffcc44'
];

const CITIES = [
  {
    id: 'epfl',
    emoji: '🏛',
    label: 'EPFL',
    sub: 'Lausanne, Switzerland',
    lat: 46.5197,
    lon: 6.5658,
    radius: 400
  },
  {
    id: 'lausanne',
    emoji: '🇨🇭',
    label: 'Lausanne',
    sub: 'Old town',
    lat: 46.5219,
    lon: 6.5793,
    radius: 500
  },
  {
    id: 'manhattan',
    emoji: '🗽',
    label: 'Manhattan',
    sub: 'New York City',
    lat: 40.7589,
    lon: -73.9851,
    radius: 400
  },
  {
    id: 'paris',
    emoji: '🇫🇷',
    label: 'Paris',
    sub: 'Eiffel Tower',
    lat: 48.8584,
    lon: 2.2945,
    radius: 400
  }
];

// ── helpers ──────────────────────────────────────────────────────────────────
function getSimComp() {
  const el = document.getElementById(SIM_ENTITY_ID);
  return el && el.components && el.components['city-simulation'];
}

// Move the orbit camera so it frames a world-space point. The camera is a
// CHILD of #cam-pivot. Strategy: snap the pivot to target with identity
// rotation, then set the camera's local position to a fixed iso offset
// and compute the rotation that makes it look at the pivot's origin
// (= the target in world). Going through setAttribute keeps A-Frame's
// component cache in sync (object3D-only mutation can race with the
// component lifecycle).
function focusOnWorldPosition(x, y, z) {
  const pivot = document.getElementById('cam-pivot');
  const cam = document.getElementById('main-cam');
  if (!pivot || !cam || typeof THREE === 'undefined') {
    return false;
  }
  const ty = y || 0;

  pivot.setAttribute('position', `${x} ${ty} ${z}`);
  pivot.setAttribute('rotation', '0 0 0');
  cam.setAttribute('position', '60 80 60');

  // Build a lookAt matrix in pivot-local space (target at origin, cam at
  // local (60,80,60)) and convert it to Euler degrees in WHATEVER Euler
  // order the camera's object3D actually uses. A-Frame can use either XYZ
  // or YXZ depending on version, so we read the order rather than guess.
  const m = new THREE.Matrix4();
  m.lookAt(
    new THREE.Vector3(60, 80, 60),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0)
  );
  const order = (cam.object3D.rotation && cam.object3D.rotation.order) || 'XYZ';
  const e = new THREE.Euler().setFromRotationMatrix(m, order);
  cam.setAttribute(
    'rotation',
    `${THREE.MathUtils.radToDeg(e.x)} ${THREE.MathUtils.radToDeg(e.y)} ${THREE.MathUtils.radToDeg(e.z)}`
  );
  return true;
}

function focusOnEntity(entity) {
  if (!entity || !entity.object3D) {
    return;
  }
  entity.object3D.updateMatrixWorld();
  const p = entity.object3D.getWorldPosition(
    typeof THREE !== 'undefined' ? new THREE.Vector3() : { x: 0, y: 0, z: 0 }
  );
  // Cars sit at y≈0; bump the focus point up slightly so the iso view
  // doesn't graze the ground plane.
  focusOnWorldPosition(p.x, p.y + 1, p.z);
}

function routeCentroid(route) {
  if (!route || route.length === 0) {
    return { x: 0, z: 0 };
  }
  let sx = 0;
  let sz = 0;
  route.forEach((wp) => {
    sx += wp.x;
    sz += wp.z;
  });
  return { x: sx / route.length, z: sz / route.length };
}

// Wipe any leftover sim entities from the scene (city + agents + VFX + root).
function wipeSim() {
  document.querySelectorAll('.crime-sim-spawned').forEach((el) => {
    if (el.parentNode) {
      el.parentNode.removeChild(el);
    }
  });
  const root = document.getElementById(SIM_ENTITY_ID);
  if (root && root.parentNode) {
    root.parentNode.removeChild(root);
  }
}

// ── City picker (initial screen) ─────────────────────────────────────────────
function CityCard({ city, onClick }) {
  return (
    <button
      onClick={() => onClick(city)}
      style={{
        background: 'rgba(20, 30, 60, 0.7)',
        border: '1px solid rgba(126, 207, 255, 0.3)',
        borderRadius: 14,
        padding: '28px 24px',
        color: '#e8f0ff',
        cursor: 'pointer',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 8,
        minWidth: 200,
        minHeight: 180,
        transition: 'transform 0.15s, border-color 0.15s, background 0.15s'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-3px)';
        e.currentTarget.style.borderColor = 'rgba(126, 207, 255, 0.7)';
        e.currentTarget.style.background = 'rgba(30, 50, 100, 0.85)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.borderColor = 'rgba(126, 207, 255, 0.3)';
        e.currentTarget.style.background = 'rgba(20, 30, 60, 0.7)';
      }}
    >
      <div style={{ fontSize: 48, lineHeight: 1 }}>{city.emoji}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>
        {city.label}
      </div>
      <div style={{ fontSize: 12, color: '#7a9acc' }}>{city.sub}</div>
    </button>
  );
}

function AddCityCard() {
  return (
    <button
      disabled
      title="Coming soon"
      style={{
        background: 'rgba(20, 30, 60, 0.3)',
        border: '1px dashed rgba(126, 207, 255, 0.25)',
        borderRadius: 14,
        padding: '28px 24px',
        color: '#556',
        cursor: 'not-allowed',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        minWidth: 200,
        minHeight: 180
      }}
    >
      <div style={{ fontSize: 48, lineHeight: 1 }}>+</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Add city</div>
      <div style={{ fontSize: 11 }}>coming soon</div>
    </button>
  );
}

function CityPicker({ onSelect }) {
  // Make sure no stale sim entities are hanging around from a previous run.
  useEffect(() => {
    wipeSim();
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background:
          'linear-gradient(135deg, #050810 0%, #0a1530 50%, #0a0e1a 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
    >
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <h1
          style={{
            fontSize: 42,
            fontWeight: 800,
            color: '#fff',
            letterSpacing: 1,
            marginBottom: 10
          }}
        >
          City Crime Simulator
        </h1>
        <div style={{ fontSize: 14, color: '#7a9acc' }}>
          Choose a city to drop a police force into.
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 20,
          maxWidth: 1100,
          width: '100%',
          padding: '0 40px'
        }}
      >
        {CITIES.map((c) => (
          <CityCard key={c.id} city={c} onClick={onSelect} />
        ))}
        <AddCityCard />
      </div>
    </div>
  );
}

// ── Live HUD (homicides, resolved, response time in IRL minutes) ─────────────
function Stat({ label, value, color }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        margin: '7px 0',
        fontSize: 13
      }}
    >
      <span style={{ color: '#7a9acc' }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 700, color: color || '#fff' }}>
        {value}
      </span>
    </div>
  );
}

function HUD() {
  const [stats, setStats] = useState({
    total: 0,
    resolved: 0,
    pending: 0,
    avgResponseMs: 0
  });
  const [osmPhase, setOsmPhase] = useState('loading'); // loading | done | error

  useEffect(() => {
    const onStats = ({ detail }) => setStats({ ...detail });
    const onOsm = ({ detail }) => {
      if (detail && detail.phase) {
        setOsmPhase(detail.phase);
      }
    };
    window.addEventListener('city-stats', onStats);
    window.addEventListener('city-osm-status', onOsm);
    return () => {
      window.removeEventListener('city-stats', onStats);
      window.removeEventListener('city-osm-status', onOsm);
    };
  }, []);

  // 1 sim-second = 1 IRL-minute. avgResponseMs is real ms; treat (ms/1000)
  // (the seconds it actually took the police to arrive in the simulation)
  // as the equivalent number of IRL minutes for the pitch.
  const responseMin =
    stats.avgResponseMs > 0 ? (stats.avgResponseMs / 1000).toFixed(1) : null;

  return (
    <div
      style={{
        background: 'rgba(6, 9, 20, 0.82)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(80, 140, 255, 0.3)',
        borderRadius: 10,
        padding: '14px 18px',
        color: '#c8deff',
        width: 240,
        fontFamily: 'inherit'
      }}
    >
      <div
        style={{
          fontSize: 12,
          letterSpacing: 2,
          color: '#6af',
          marginBottom: 12,
          textTransform: 'uppercase',
          fontWeight: 700
        }}
      >
        🏙 City Crime Monitor
      </div>
      {osmPhase === 'loading' && (
        <div style={{ fontSize: 11, color: '#ffc847', marginBottom: 8 }}>
          ⏳ Building city from OpenStreetMap…
        </div>
      )}
      {osmPhase === 'error' && (
        <div style={{ fontSize: 11, color: '#ff5555', marginBottom: 8 }}>
          ⚠ OSM fetch failed. Try again.
        </div>
      )}
      <Stat label="Homicides" value={stats.total} color="#ff5555" />
      <Stat label="Resolved" value={stats.resolved} color="#50fa7b" />
      <Stat label="Pending" value={stats.pending} color="#ffc847" />
      <Stat
        label="Avg response"
        value={responseMin ? `${responseMin} min` : '—'}
        color="#6af"
      />
    </div>
  );
}

// ── Focus camera menu (mirror of editor's, decoupled from inspector) ─────────
function FocusMenu() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const sim = getSimComp();
  if (!sim) {
    return null;
  }
  const police = sim.police || [];
  const routes = sim.routes || [];

  const card = {
    position: 'fixed',
    bottom: 16,
    left: 16,
    background: 'rgba(6, 9, 20, 0.82)',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(80,140,255,0.3)',
    borderRadius: 10,
    padding: '12px 16px',
    color: '#c8deff',
    zIndex: 200,
    maxWidth: 360
  };
  const header = {
    fontSize: 11,
    color: '#6af',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: 700
  };
  const chip = (color) => ({
    background: color,
    color: '#000',
    border: 'none',
    borderRadius: 4,
    padding: '4px 7px',
    fontSize: 10,
    fontWeight: 700,
    cursor: 'pointer',
    minWidth: 28
  });

  if (police.length === 0 && routes.length === 0) {
    return null;
  }

  return (
    <div style={card} data-tick={tick}>
      <div style={header}>🎯 Focus camera</div>

      {police.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: '#778', marginBottom: 4 }}>
            Police cars ({police.length})
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              marginBottom: 8
            }}
          >
            {police.map((car, i) => (
              <button
                key={`car-${i}`}
                style={chip(ROUTE_COLORS[i % ROUTE_COLORS.length])}
                title={`Police #${i + 1}`}
                onClick={() => focusOnEntity(car.el)}
              >
                🚓 {i + 1}
              </button>
            ))}
          </div>
        </>
      )}

      {routes.length > 0 && (
        <>
          <div style={{ fontSize: 10, color: '#778', marginBottom: 4 }}>
            Routes ({routes.length})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {routes.map((route, i) => (
              <button
                key={`route-${i}`}
                style={chip(ROUTE_COLORS[i % ROUTE_COLORS.length])}
                title={`Route #${i + 1} (${route.length} waypoints)`}
                onClick={() => {
                  const c = routeCentroid(route);
                  focusOnWorldPosition(c.x, 0, c.z);
                }}
              >
                🛣 {i + 1}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Live parameter sliders ───────────────────────────────────────────────────
// Crime rate + police speed apply live to the running simulation. Citizens
// and police count are saved to state but only applied when a new city is
// built (changing them mid-run would require respawning agents).
function Slider({ label, min, max, step, value, unit, fmt, onChange }) {
  const display = fmt ? fmt(value) : value;
  return (
    <div style={{ margin: '8px 0' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 3
        }}
      >
        <label style={{ fontSize: 11, color: '#99aabb' }}>{label}</label>
        <span style={{ fontSize: 11, color: '#7ecfff' }}>
          {display}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#7ecfff', cursor: 'pointer' }}
      />
    </div>
  );
}

function Parameters({ params, setParams }) {
  const apply = (key, val) => {
    setParams((p) => ({ ...p, [key]: val }));
    const sim = getSimComp();
    if (!sim) {
      return;
    }
    if (key === 'crimeRate') {
      sim.data.crimeRate = val;
      sim.citizens.forEach((c) => {
        c.data.crimeRate = val;
      });
    } else if (key === 'policeSpeed') {
      sim.data.policeSpeed = val;
      sim.police.forEach((p) => {
        p.data.speed = val;
      });
    }
    // citizenCount / policeCount take effect on the next city rebuild —
    // changing them mid-run would mean respawning agents.
  };

  return (
    <div
      style={{
        background: 'rgba(6, 9, 20, 0.82)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(80, 140, 255, 0.3)',
        borderRadius: 10,
        padding: '14px 18px',
        color: '#c8deff',
        width: 240,
        fontFamily: 'inherit'
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: 2,
          color: '#6af',
          marginBottom: 8,
          textTransform: 'uppercase',
          fontWeight: 700
        }}
      >
        Parameters
      </div>
      <Slider
        label="Citizens"
        min={1}
        max={50}
        step={1}
        value={params.citizenCount}
        onChange={(v) => apply('citizenCount', v)}
      />
      <Slider
        label="Police cars"
        min={1}
        max={15}
        step={1}
        value={params.policeCount}
        onChange={(v) => apply('policeCount', v)}
      />
      <Slider
        label="Crime rate / s"
        min={0.001}
        max={0.05}
        step={0.001}
        value={params.crimeRate}
        fmt={(v) => v.toFixed(3)}
        onChange={(v) => apply('crimeRate', v)}
      />
      <Slider
        label="Police speed"
        min={2}
        max={20}
        step={1}
        value={params.policeSpeed}
        unit=" u/s"
        onChange={(v) => apply('policeSpeed', v)}
      />
      <div
        style={{
          fontSize: 10,
          color: '#556',
          marginTop: 6,
          fontStyle: 'italic'
        }}
      >
        Citizens / Police count apply on next city rebuild.
      </div>
    </div>
  );
}

// ── Tiny control bar (Force crime + Pause + Back) ────────────────────────────
function Controls({ onBack }) {
  const [paused, setPaused] = useState(false);

  const togglePause = useCallback(() => {
    const el = document.getElementById(SIM_ENTITY_ID);
    if (!el) {
      return;
    }
    const next = !paused;
    el.setAttribute('city-simulation', 'paused', next);
    setPaused(next);
  }, [paused]);

  const forceCrime = useCallback(() => {
    const sim = getSimComp();
    if (!sim) {
      return;
    }
    const wanderers = sim.citizens.filter((c) => c.state === 'wandering');
    if (wanderers.length < 2) {
      return;
    }
    // city-simulation.attemptCrime only fires if a victim is within 12m of
    // the attacker. In sparse OSM cities (15 citizens over 400m radius)
    // that's often nobody, so the button silently no-ops. Find an attacker
    // who already has a viable victim nearby.
    const d2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z);
    const RANGE2 = 12 * 12;
    const candidates = wanderers.filter((a) =>
      wanderers.some(
        (b) =>
          a !== b && d2(a.el.object3D.position, b.el.object3D.position) < RANGE2
      )
    );
    if (candidates.length > 0) {
      sim.attemptCrime(
        candidates[Math.floor(Math.random() * candidates.length)]
      );
      return;
    }
    // Last resort — no two citizens are close enough naturally. Teleport
    // one wanderer right next to another so the 12m check passes. The
    // citizen-agent picks a new sidewalk node next tick after fleeing.
    const a = wanderers[0];
    const b = wanderers[1];
    const bp = b.el.object3D.position;
    a.el.object3D.position.set(bp.x + 4, 0, bp.z + 4);
    sim.attemptCrime(a);
  }, []);

  const btn = {
    background: 'rgba(6, 9, 20, 0.85)',
    color: '#6af',
    border: '1px solid rgba(80, 140, 255, 0.4)',
    borderRadius: 6,
    padding: '8px 14px',
    fontSize: 12,
    fontFamily: 'inherit',
    fontWeight: 600,
    letterSpacing: 1,
    cursor: 'pointer'
  };
  const danger = {
    ...btn,
    color: '#f86',
    borderColor: 'rgba(255, 80, 80, 0.5)'
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 8,
        zIndex: 200
      }}
    >
      <button style={btn} onClick={onBack}>
        ← Cities
      </button>
      <button style={btn} onClick={togglePause}>
        {paused ? '▶ Resume' : '⏸ Pause'}
      </button>
      <button style={danger} onClick={forceCrime}>
        🔫 Force crime
      </button>
    </div>
  );
}

// ── Pending-crime markers (red pulsing pillars on the map) ──────────────────
// Imperative bridge to A-Frame: we don't render <a-cylinder> via React because
// react-aframe binding adds complexity. Instead, this component mounts/unmounts
// plain DOM <a-entity> children of <a-scene> in sync with sim.pendingCrimes.
//
// Lifecycle: poll every 500ms, diff against the current marker set keyed by
// crime.ts (unique per crime), add new markers, remove markers whose crimes
// are no longer in pendingCrimes (= cop reached the scene → resolved).
function CrimeMarkers() {
  const markersRef = useRef(new Map());

  useEffect(() => {
    const scene = document.querySelector('a-scene');
    if (!scene) {
      return undefined;
    }
    // Capture the ref value here so the cleanup uses the same Map instance
    // that this effect populated (silences the react-hooks/exhaustive-deps
    // warning about ref values changing between mount and unmount).
    const markers = markersRef.current;
    let stopped = false;

    const buildMarker = (c) => {
      const wrap = document.createElement('a-entity');
      wrap.classList.add(SPAWN_CLASS);
      wrap.setAttribute('position', `${c.x} 0 ${c.z}`);

      // Tall vertical red pillar — visible from any altitude.
      const pillar = document.createElement('a-cylinder');
      pillar.setAttribute('radius', 0.8);
      pillar.setAttribute('height', 30);
      pillar.setAttribute('color', '#ff2030');
      pillar.setAttribute(
        'material',
        'shader: flat; emissive: #ff0010; emissiveIntensity: 2'
      );
      pillar.setAttribute('position', '0 15 0');
      pillar.setAttribute(
        'animation',
        'property: scale; from: 1 1 1; to: 1.35 1 1.35; dur: 700; dir: alternate; loop: true; easing: easeInOutSine'
      );
      wrap.appendChild(pillar);

      // Ground ring with a pulsing scale to draw the eye.
      const ring = document.createElement('a-ring');
      ring.setAttribute('radius-inner', 1.5);
      ring.setAttribute('radius-outer', 3.2);
      ring.setAttribute('rotation', '-90 0 0');
      ring.setAttribute('position', '0 0.12 0');
      ring.setAttribute('color', '#ff2030');
      ring.setAttribute(
        'material',
        'side: double; emissive: #ff0010; emissiveIntensity: 1; transparent: true; opacity: 0.85'
      );
      ring.setAttribute(
        'animation',
        'property: scale; from: 1 1 1; to: 1.7 1.7 1; dur: 1000; dir: alternate; loop: true; easing: easeInOutSine'
      );
      wrap.appendChild(ring);

      return wrap;
    };

    const poll = () => {
      if (stopped) {
        return;
      }
      const sim = getSimComp();
      if (!sim) {
        setTimeout(poll, 200);
        return;
      }
      const pending = sim.pendingCrimes || [];
      const seen = new Set();

      // Add a marker for any pending crime we don't already have one for.
      pending.forEach((c) => {
        const key = String(c.ts);
        seen.add(key);
        if (markers.has(key)) {
          return;
        }
        const m = buildMarker(c);
        scene.appendChild(m);
        markers.set(key, m);
      });

      // Remove markers whose crime is no longer pending (= resolved or sim
      // was rebuilt from scratch and pending was cleared).
      markers.forEach((entity, key) => {
        if (seen.has(key)) {
          return;
        }
        if (entity.parentNode) {
          entity.parentNode.removeChild(entity);
        }
        markers.delete(key);
      });

      setTimeout(poll, 200);
    };
    poll();

    return () => {
      stopped = true;
      markers.forEach((entity) => {
        if (entity.parentNode) {
          entity.parentNode.removeChild(entity);
        }
      });
      markers.clear();
    };
  }, []);

  return null;
}

// ── Crime alert popup ────────────────────────────────────────────────────────
// Shown for ~AUTO_DISMISS_MS when a new crime fires. "Yes" hands control to
// the camera-follow loop in DemoView; "No" just dismisses.
const ALERT_AUTO_DISMISS_MS = 8000;

function CrimeAlertPopup({ crime, onYes, onNo }) {
  // Auto-dismiss so the popup never blocks the user's view forever.
  useEffect(() => {
    const t = setTimeout(onNo, ALERT_AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [crime, onNo]);

  const card = {
    position: 'fixed',
    top: 80,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(20, 5, 5, 0.92)',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(255, 80, 80, 0.5)',
    borderRadius: 10,
    padding: '14px 20px',
    color: '#ffd0d0',
    boxShadow: '0 4px 24px rgba(120, 0, 0, 0.6)',
    zIndex: 300,
    minWidth: 320,
    fontFamily: 'inherit',
    animation: 'crimeFlash 0.4s ease-out'
  };
  const btn = {
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 1,
    cursor: 'pointer',
    fontFamily: 'inherit'
  };

  return (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        🔫 Homicide reported
      </div>
      <div style={{ fontSize: 11, color: '#aa9090', marginBottom: 12 }}>
        at ({crime.x.toFixed(1)}, {crime.z.toFixed(1)}) — follow the responding
        car?
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          style={{ ...btn, background: '#333', color: '#bbb' }}
          onClick={onNo}
        >
          No
        </button>
        <button
          style={{ ...btn, background: '#aa3030', color: '#fff' }}
          onClick={onYes}
        >
          Yes, follow
        </button>
      </div>
    </div>
  );
}

// ── Resolution banner shown when the followed cop arrives at the crime ─────
function ResolutionBanner({ responseMin }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 70,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(8, 30, 12, 0.94)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(80, 250, 123, 0.55)',
        boxShadow: '0 0 24px rgba(80, 250, 123, 0.25)',
        borderRadius: 10,
        padding: '14px 22px',
        color: '#d8ffe0',
        zIndex: 260,
        minWidth: 320,
        textAlign: 'center',
        fontFamily: 'inherit'
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 1,
          color: '#50fa7b',
          textTransform: 'uppercase',
          marginBottom: 4
        }}
      >
        ✓ Crime resolved
      </div>
      <div style={{ fontSize: 12, color: '#aac9ad' }}>
        Response time:{' '}
        <b style={{ color: '#fff' }}>{responseMin.toFixed(1)} min</b>
      </div>
    </div>
  );
}

// ── "Now following" indicator (top-center, with stop button) ────────────────
function FollowIndicator({ carNum, color, onStop }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 70,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(6, 9, 20, 0.85)',
        backdropFilter: 'blur(8px)',
        border: `1px solid ${color || '#7ecfff'}`,
        borderRadius: 8,
        padding: '8px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        color: '#c8deff',
        fontSize: 12,
        zIndex: 250,
        fontFamily: 'inherit'
      }}
    >
      <span>
        🎥 Following <b style={{ color }}>Police #{carNum}</b>
      </span>
      <button
        onClick={onStop}
        style={{
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.2)',
          color: '#c8deff',
          borderRadius: 4,
          padding: '3px 8px',
          fontSize: 10,
          cursor: 'pointer',
          fontFamily: 'inherit'
        }}
      >
        stop
      </button>
    </div>
  );
}

// ── Running view ─────────────────────────────────────────────────────────────
function DemoView({ city, params, setParams, onBack }) {
  const [crimeAlert, setCrimeAlert] = useState(null);
  const [followingCar, setFollowingCar] = useState(null);
  // The crime we're tailing — needed to compute response time once resolved.
  const [followingCrime, setFollowingCrime] = useState(null);
  // Resolution banner content; non-null while the followed cop is at-scene.
  const [resolution, setResolution] = useState(null); // { responseMin }
  // Held in a ref so the demo.html drag handler can read it without a re-render.
  const followingRef = useRef(null);
  followingRef.current = followingCar;
  // Tell demo.html's drag handler to ignore mouse drags while we're following.
  useEffect(() => {
    window.__demoFollowing = !!followingCar;
    return () => {
      window.__demoFollowing = false;
    };
  }, [followingCar]);

  // ── Listen for crime events → show the popup ──────────────────────────────
  // city-simulation emits 'city-crime' on the scene SYNCHRONOUSLY before
  // _dispatch runs. So the responder isn't assigned yet at this exact moment;
  // we just record the crime and look up the responder when the user clicks
  // "Yes" (by then dispatch has completed).
  useEffect(() => {
    const scene = document.querySelector('a-scene');
    if (!scene) {
      return undefined;
    }
    const onCrime = ({ detail }) => {
      // If we're already following, don't interrupt with another popup.
      if (followingRef.current) {
        return;
      }
      setCrimeAlert({ x: detail.x, z: detail.z, ts: Date.now() });
    };
    scene.addEventListener('city-crime', onCrime);
    return () => scene.removeEventListener('city-crime', onCrime);
  }, []);

  // ── Camera follow loop (only active while followingCar is set) ────────────
  // Detects the responding → at-scene transition and pops the resolution
  // banner; keeps following through the at-scene wait so the user can see
  // the arrest before being released back to free camera.
  useEffect(() => {
    if (!followingCar) {
      return undefined;
    }
    let alive = true;
    let sawAtScene = false;
    const tick = () => {
      if (!alive) {
        return;
      }
      const car = followingCar;
      if (!car || !car.el || !car.el.parentNode) {
        setFollowingCar(null);
        return;
      }

      // RESPONDING → AT_SCENE: cop just reached the crime. Compute response
      // time from the saved crime timestamp (1 sim-second = 1 IRL-minute).
      if (!sawAtScene && car.state === 'at_scene') {
        sawAtScene = true;
        if (followingCrime) {
          const responseMin = (Date.now() - followingCrime.ts) / 1000;
          setResolution({ responseMin });
        }
      }

      // AT_SCENE → PATROLLING: cop is leaving. End the follow.
      if (sawAtScene && car.state === 'patrolling') {
        setFollowingCar(null);
        return;
      }

      const p = car.el.object3D.getWorldPosition(new THREE.Vector3());
      focusOnWorldPosition(p.x, p.y + 1, p.z);
      setTimeout(tick, 100);
    };
    tick();
    return () => {
      alive = false;
    };
  }, [followingCar, followingCrime]);

  // When the follow ends, clear the resolution banner after a short pause
  // so the user has time to read it.
  useEffect(() => {
    if (followingCar) {
      return undefined;
    }
    if (!resolution) {
      return undefined;
    }
    const t = setTimeout(() => {
      setResolution(null);
      setFollowingCrime(null);
    }, 2500);
    return () => clearTimeout(t);
  }, [followingCar, resolution]);

  const acceptFollow = useCallback(() => {
    const sim = getSimComp();
    if (!sim || !crimeAlert) {
      setCrimeAlert(null);
      return;
    }
    // _dispatch runs synchronously after the city-crime emit, so by now
    // exactly one police car should be in 'responding' state with its
    // crimeScene matching this crime's coordinates.
    const responder = sim.police.find(
      (p) =>
        p.state === 'responding' &&
        p.crimeScene &&
        Math.abs(p.crimeScene.x - crimeAlert.x) < 0.5 &&
        Math.abs(p.crimeScene.z - crimeAlert.z) < 0.5
    );
    if (responder) {
      setFollowingCar(responder);
      setFollowingCrime(crimeAlert);
      setResolution(null);
    }
    setCrimeAlert(null);
  }, [crimeAlert]);

  const declineFollow = useCallback(() => setCrimeAlert(null), []);

  // Keep the slider state in sync with sim.data — the AI Mayor's tools
  // (set_crime_rate / set_police_speed) mutate the live simulation but
  // can't directly setState in this component. Poll sim.data and pull
  // the values back into params if they've drifted.
  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (stopped) {
        return;
      }
      const sim = getSimComp();
      if (sim && sim.data) {
        setParams((p) => {
          const live = {
            crimeRate: sim.data.crimeRate,
            policeSpeed: sim.data.policeSpeed
          };
          if (
            p.crimeRate === live.crimeRate &&
            p.policeSpeed === live.policeSpeed
          ) {
            return p;
          }
          return { ...p, ...live };
        });
      }
      setTimeout(tick, 500);
    };
    tick();
    return () => {
      stopped = true;
    };
  }, [setParams]);

  // Build the chosen city when mounted (and rebuild if city changes).
  // Citizens/police counts are read at build time only — that's why they're
  // listed as deps but crimeRate/policeSpeed aren't (those apply live).
  useEffect(() => {
    const scene = document.querySelector('a-scene');
    if (!scene) {
      return undefined;
    }

    wipeSim();

    const el = document.createElement('a-entity');
    el.id = SIM_ENTITY_ID;
    el.setAttribute('city-simulation', {
      citizenCount: params.citizenCount,
      policeCount: params.policeCount,
      crimeRate: params.crimeRate,
      citizenSpeed: 1.5,
      policeSpeed: params.policeSpeed,
      paused: false,
      spawnCity: false,
      autoSpawn: false
    });
    scene.appendChild(el);

    let cancelled = false;
    const callBuild = () => {
      if (cancelled) {
        return;
      }
      const comp = el.components && el.components['city-simulation'];
      if (!comp) {
        setTimeout(callBuild, 50);
        return;
      }
      comp
        .buildOSMCity(city.lat, city.lon, city.radius)
        .catch((err) => console.error('[demo] OSM build failed:', err));
    };
    callBuild();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, params.citizenCount, params.policeCount]);

  return (
    <>
      {/* Left rail: HUD + Parameters stacked. */}
      <div
        style={{
          position: 'fixed',
          top: 16,
          left: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          zIndex: 200,
          maxHeight: 'calc(100vh - 32px)',
          overflowY: 'auto'
        }}
      >
        <HUD />
        <Parameters params={params} setParams={setParams} />
      </div>
      <Controls onBack={onBack} />
      <FocusMenu />
      <CrimeMarkers />
      {crimeAlert && !followingCar && (
        <CrimeAlertPopup
          crime={crimeAlert}
          onYes={acceptFollow}
          onNo={declineFollow}
        />
      )}
      {/* While the cop is still en-route, show the "Following" indicator.
          Once they've reached the scene, swap it for the resolution banner
          (response time displayed in IRL minutes). */}
      {followingCar &&
        !resolution &&
        (() => {
          const sim = getSimComp();
          const idx = sim ? sim.police.indexOf(followingCar) : -1;
          const color = ROUTE_COLORS[Math.max(idx, 0) % ROUTE_COLORS.length];
          return (
            <FollowIndicator
              carNum={idx + 1}
              color={color}
              onStop={() => setFollowingCar(null)}
            />
          );
        })()}
      {resolution && <ResolutionBanner responseMin={resolution.responseMin} />}
      <div
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          bottom: 16,
          width: 380,
          background: 'rgba(6, 9, 20, 0.88)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(80, 140, 255, 0.3)',
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 200
        }}
      >
        <MayorChatPanel />
      </div>
    </>
  );
}

// ── App root ─────────────────────────────────────────────────────────────────
function DemoApp() {
  const [city, setCity] = useState(null);
  const [params, setParams] = useState({
    citizenCount: 15,
    policeCount: 6,
    crimeRate: 0.003,
    policeSpeed: 8
  });
  if (!city) {
    return <CityPicker onSelect={setCity} />;
  }
  return (
    <DemoView
      city={city}
      params={params}
      setParams={setParams}
      onBack={() => setCity(null)}
    />
  );
}

// Mount when the DOM is ready (the script is at the end of body, so it usually is).
function mount() {
  const el = document.getElementById('demo-root');
  if (!el) {
    console.error('[demo] #demo-root not found');
    return;
  }
  createRoot(el).render(<DemoApp />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
