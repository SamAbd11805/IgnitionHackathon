import { useState, useEffect, useCallback } from 'react';

const SIM_ENTITY_ID = 'crime-sim-root';

// ── helpers ──────────────────────────────────────────────────────────────────
function getSimComp() {
  const el = document.getElementById(SIM_ENTITY_ID);
  return el && el.components && el.components['city-simulation'];
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}

// ── sub-components ────────────────────────────────────────────────────────────
function StatBox({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#fff' }}>
        {value}
      </div>
      <div
        style={{
          fontSize: 10,
          color: '#778',
          marginTop: 2,
          textTransform: 'uppercase',
          letterSpacing: 1
        }}
      >
        {label}
      </div>
    </div>
  );
}

function Slider({ label, id, min, max, step, value, unit, onChange }) {
  return (
    <div style={{ margin: '10px 0' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 4
        }}
      >
        <label style={{ fontSize: 11, color: '#99aabb' }}>{label}</label>
        <span style={{ fontSize: 11, color: '#7ecfff' }}>
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        id={id}
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

// ── main panel ────────────────────────────────────────────────────────────────
export default function CrimeSimPanel() {
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [citizenCount, setCitizenCount] = useState(15);
  const [policeCount, setPoliceCount] = useState(3);
  const [crimeRate, setCrimeRate] = useState(0.003);
  const [policeSpeed, setPoliceSpeed] = useState(8);
  const [stats, setStats] = useState({
    total: 0,
    resolved: 0,
    pending: 0,
    avgResponseMs: 0
  });
  const [log, setLog] = useState([]);

  // ── listen for stats broadcasts from city-simulation ─────────────────────
  useEffect(() => {
    const onStats = ({ detail }) => setStats({ ...detail });
    const onCrime = ({ detail }) => {
      const time = new Date().toLocaleTimeString();
      const entry = `[${time}] ⚠ Homicide at (${Number(detail.x).toFixed(1)}, ${Number(detail.z).toFixed(1)})`;
      setLog((prev) => [entry, ...prev].slice(0, 20));
    };
    window.addEventListener('city-stats', onStats);
    const scene = document.querySelector('a-scene');
    if (scene) {
      scene.addEventListener('city-crime', onCrime);
    }
    return () => {
      window.removeEventListener('city-stats', onStats);
      if (scene) {
        scene.removeEventListener('city-crime', onCrime);
      }
    };
  }, []);

  // ── start simulation ──────────────────────────────────────────────────────
  const startSim = useCallback(() => {
    const scene = document.querySelector('a-scene');
    if (!scene) {
      console.warn('[CrimeSim] No a-scene found');
      return;
    }

    // Remove any existing sim entity
    const existing = document.getElementById(SIM_ENTITY_ID);
    if (existing) {
      existing.parentNode.removeChild(existing);
    }

    const el = document.createElement('a-entity');
    el.id = SIM_ENTITY_ID;
    el.setAttribute('city-simulation', {
      citizenCount,
      policeCount,
      crimeRate,
      citizenSpeed: 1.5,
      policeSpeed,
      paused: false
    });
    scene.appendChild(el);
    setRunning(true);
    setPaused(false);
    setStats({ total: 0, resolved: 0, pending: 0, avgResponseMs: 0 });
    setLog([]);
  }, [citizenCount, policeCount, crimeRate, policeSpeed]);

  // ── stop simulation ───────────────────────────────────────────────────────
  const stopSim = useCallback(() => {
    const el = document.getElementById(SIM_ENTITY_ID);
    if (el) {
      const comp = el.components && el.components['city-simulation'];
      if (comp) {
        [...comp.citizens, ...comp.police].forEach((a) => {
          if (a.el && a.el.parentNode) {
            a.el.parentNode.removeChild(a.el);
          }
        });
      }
      el.parentNode.removeChild(el);
    }
    setRunning(false);
    setPaused(false);
  }, []);

  // ── pause / resume ────────────────────────────────────────────────────────
  const togglePause = useCallback(() => {
    const el = document.getElementById(SIM_ENTITY_ID);
    if (!el) {
      return;
    }
    const next = !paused;
    el.setAttribute('city-simulation', 'paused', next);
    setPaused(next);
  }, [paused]);

  // ── force a crime ─────────────────────────────────────────────────────────
  const forceCrime = useCallback(() => {
    const comp = getSimComp();
    if (!comp) {
      return;
    }
    const wanderers = comp.citizens.filter((c) => c.state === 'wandering');
    if (wanderers.length > 1) {
      comp.attemptCrime(
        wanderers[Math.floor(Math.random() * wanderers.length)]
      );
    }
  }, []);

  // ── live-update sliders while sim is running ──────────────────────────────
  const updateCrimeRate = useCallback((val) => {
    setCrimeRate(val);
    const comp = getSimComp();
    if (comp) {
      comp.citizens.forEach((c) => {
        c.data.crimeRate = val;
      });
    }
  }, []);

  const updatePoliceSpeed = useCallback((val) => {
    setPoliceSpeed(val);
    const comp = getSimComp();
    if (comp) {
      comp.police.forEach((p) => {
        p.data.speed = val;
      });
    }
  }, []);

  // ── styles ────────────────────────────────────────────────────────────────
  const card = {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(100,160,255,0.15)',
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 10
  };

  const btnBase = {
    flex: 1,
    padding: '8px 0',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    transition: 'opacity 0.15s'
  };

  return (
    <div
      style={{
        padding: '12px 14px',
        color: '#c8deff',
        fontSize: 13,
        overflowY: 'auto',
        height: '100%'
      }}
    >
      {/* ── Header ── */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: '#7ecfff',
            letterSpacing: 1,
            textTransform: 'uppercase'
          }}
        >
          🔫 Crime Simulation
        </div>
        <div style={{ fontSize: 11, color: '#556', marginTop: 3 }}>
          Agent-based urban crime model
        </div>
      </div>

      {/* ── Stats (live) ── */}
      {running && (
        <div style={{ ...card, display: 'flex', gap: 8, marginBottom: 12 }}>
          <StatBox label="Homicides" value={fmt(stats.total)} color="#ff6b6b" />
          <StatBox
            label="Resolved"
            value={fmt(stats.resolved)}
            color="#50fa7b"
          />
          <StatBox label="Pending" value={fmt(stats.pending)} color="#ffc847" />
          <StatBox
            label="Avg resp."
            value={stats.avgResponseMs ? stats.avgResponseMs + 'ms' : '—'}
            color="#7ecfff"
          />
        </div>
      )}

      {/* ── Config sliders ── */}
      <div style={card}>
        <div
          style={{
            fontSize: 11,
            color: '#99aabb',
            marginBottom: 8,
            textTransform: 'uppercase',
            letterSpacing: 1
          }}
        >
          Parameters
        </div>
        <Slider
          label="Citizens"
          id="sl-citizens"
          min={5}
          max={40}
          step={1}
          value={citizenCount}
          unit=""
          onChange={setCitizenCount}
        />
        <Slider
          label="Police cars"
          id="sl-police"
          min={1}
          max={8}
          step={1}
          value={policeCount}
          unit=""
          onChange={setPoliceCount}
        />
        <Slider
          label="Crime rate / s"
          id="sl-crime"
          min={0.001}
          max={0.05}
          step={0.001}
          value={crimeRate}
          unit=""
          onChange={updateCrimeRate}
        />
        <Slider
          label="Police speed"
          id="sl-speed"
          min={2}
          max={20}
          step={1}
          value={policeSpeed}
          unit=" u/s"
          onChange={updatePoliceSpeed}
        />
      </div>

      {/* ── Action buttons ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        {!running ? (
          <button
            onClick={startSim}
            style={{
              ...btnBase,
              background: '#1a7a3a',
              color: '#fff',
              flex: 2
            }}
          >
            ▶ Start Simulation
          </button>
        ) : (
          <>
            <button
              onClick={togglePause}
              style={{
                ...btnBase,
                background: paused ? '#1a5a8a' : '#5a6a2a',
                color: '#fff'
              }}
            >
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button
              onClick={forceCrime}
              style={{ ...btnBase, background: '#7a1a1a', color: '#fff' }}
              title="Force a crime event immediately"
            >
              🔫 Crime
            </button>
            <button
              onClick={stopSim}
              style={{ ...btnBase, background: '#333', color: '#888' }}
            >
              ■ Stop
            </button>
          </>
        )}
      </div>

      {/* ── Event log ── */}
      {running && (
        <div style={card}>
          <div
            style={{
              fontSize: 11,
              color: '#99aabb',
              marginBottom: 6,
              textTransform: 'uppercase',
              letterSpacing: 1
            }}
          >
            Event log
          </div>
          {log.length === 0 ? (
            <div style={{ fontSize: 11, color: '#445', fontStyle: 'italic' }}>
              No events yet…
            </div>
          ) : (
            log.map((entry, i) => (
              <div
                key={i}
                style={{
                  fontSize: 10,
                  color: i === 0 ? '#ff8888' : '#556',
                  padding: '2px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.04)'
                }}
              >
                {entry}
              </div>
            ))
          )}
        </div>
      )}

      {/* ── How it works ── */}
      {!running && (
        <div style={{ ...card, fontSize: 11, color: '#556', lineHeight: 1.7 }}>
          <div style={{ color: '#99aabb', marginBottom: 4 }}>How it works</div>
          Each citizen has a small probability per second of committing a crime
          against a nearby neighbor. Police cars patrol predefined routes and
          are dispatched to the nearest crime scene.
          <br />
          <br />
          <span style={{ color: '#7ecfff' }}>
            Configure above, then press Start.
          </span>
        </div>
      )}
    </div>
  );
}
