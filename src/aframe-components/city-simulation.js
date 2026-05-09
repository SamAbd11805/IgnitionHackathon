/* city-simulation.js
 * Three A-Frame components:
 *   citizen-agent      – individual pedestrian with crime probability
 *   police-agent       – patrol car that responds to crimes
 *   city-simulation    – master orchestrator (attach to any entity)
 */

// ── Shared helpers ───────────────────────────────────────────────────────────
const rand = (a, b) => a + Math.random() * (b - a);
const dist2D = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);

const CS = {
  // Citizen States
  WANDERING: 'wandering',
  FLEEING: 'fleeing',
  DEAD: 'dead',
  ARRESTED: 'arrested'
};
const PS = {
  // Police States
  PATROLLING: 'patrolling',
  RESPONDING: 'responding',
  AT_SCENE: 'at_scene'
};

// ── citizen-agent ────────────────────────────────────────────────────────────
AFRAME.registerComponent('citizen-agent', {
  schema: {
    speed: { type: 'number', default: 1.5 },
    crimeRate: { type: 'number', default: 0.003 }, // probability per second
    boundsX: { type: 'number', default: 18 },
    boundsZ: { type: 'number', default: 12 }
  },

  init() {
    this.state = CS.WANDERING;
    this.target = this._newTarget();
    this.crimeTimer = 0;
    this.simComp = null; // set by city-simulation after spawn
  },

  _newTarget() {
    return {
      x: rand(-this.data.boundsX, this.data.boundsX),
      z: rand(-this.data.boundsZ, this.data.boundsZ)
    };
  },

  tick(t, delta) {
    if (this.state === CS.DEAD || this.state === CS.ARRESTED) return;

    const dt = delta / 1000;
    const pos = this.el.object3D.position;

    // ── Crime probability check (once per second) ──────────────────────────
    if (this.state === CS.WANDERING) {
      this.crimeTimer += dt;
      if (this.crimeTimer >= 1) {
        this.crimeTimer = 0;
        if (this.simComp && Math.random() < this.data.crimeRate) {
          this.simComp.attemptCrime(this);
          return;
        }
      }
    }

    // ── Move toward target ─────────────────────────────────────────────────
    const dx = this.target.x - pos.x;
    const dz = this.target.z - pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);

    if (d < 0.6) {
      this.target = this._newTarget();
    } else {
      const spd =
        this.state === CS.FLEEING ? this.data.speed * 2.8 : this.data.speed;
      pos.x += (dx / d) * spd * dt;
      pos.z += (dz / d) * spd * dt;
      this.el.object3D.rotation.y = Math.atan2(dx, dz);
    }
  },

  // Public API called by city-simulation ─────────────────────────────────────
  flee() {
    this.state = CS.FLEEING;
    this.target = this._newTarget();
  },

  die() {
    this.state = CS.DEAD;
    this.el.setAttribute('visible', false);
  },

  arrest() {
    if (this.state !== CS.FLEEING) return false;
    this.state = CS.ARRESTED;
    this.el.setAttribute('visible', false);
    return true;
  }
});

// ── police-agent ─────────────────────────────────────────────────────────────
AFRAME.registerComponent('police-agent', {
  schema: {
    speed: { type: 'number', default: 8 },
    route: { type: 'string', default: '' } // space-separated x z pairs
  },

  init() {
    this.state = PS.PATROLLING;
    this.crimeScene = null;
    this.waypointIdx = 0;
    this.atSceneTimer = 0;
    this.sirenTimer = 0;
    this.sirenPhase = false;
    this.simComp = null;

    // Parse patrol waypoints
    const nums = this.data.route.trim().split(/\s+/).map(Number);
    this.waypoints = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      this.waypoints.push({ x: nums[i], z: nums[i + 1] });
    }
    if (this.waypoints.length > 0) {
      const wp = this.waypoints[0];
      this.el.object3D.position.set(wp.x, 0, wp.z);
    }

    // Siren point light (alternates blue / red when responding)
    const siren = document.createElement('a-light');
    siren.setAttribute('type', 'point');
    siren.setAttribute('color', '#0044ff');
    siren.setAttribute('intensity', '0');
    siren.setAttribute('distance', '14');
    siren.setAttribute('decay', '2');
    siren.setAttribute('position', '0 1.5 0');
    this.el.appendChild(siren);
    this.sirenEl = siren;

    // Blue colour tint applied to every mesh in the vehicle model
    this.el.addEventListener('model-loaded', () => {
      this.el.object3D.traverse((child) => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material)
          ? child.material
          : [child.material];
        mats.forEach((m) => {
          if (m.color) {
            m.color.set('#1144ee');
            m.needsUpdate = true;
          }
        });
      });
    });
  },

  // Called by city-simulation ─────────────────────────────────────────────────
  respondTo(scene) {
    this.state = PS.RESPONDING;
    this.crimeScene = scene;
    this.sirenEl.setAttribute('intensity', '4');
  },

  tick(t, delta) {
    const dt = delta / 1000;
    const pos = this.el.object3D.position;

    // ── Siren flash ────────────────────────────────────────────────────────
    const sirenActive =
      this.state === PS.RESPONDING || this.state === PS.AT_SCENE;
    if (sirenActive) {
      this.sirenTimer += dt;
      if (this.sirenTimer > 0.22) {
        this.sirenTimer = 0;
        this.sirenPhase = !this.sirenPhase;
        this.sirenEl.setAttribute(
          'color',
          this.sirenPhase ? '#0044ff' : '#ff2200'
        );
      }
    }

    // ── AT_SCENE: wait, then resume patrol ────────────────────────────────
    if (this.state === PS.AT_SCENE) {
      this.atSceneTimer += dt;
      if (this.atSceneTimer > 4) {
        this.state = PS.PATROLLING;
        this.crimeScene = null;
        this.atSceneTimer = 0;
        this.sirenEl.setAttribute('intensity', '0');
      }
      return;
    }

    // ── Pick movement target ───────────────────────────────────────────────
    const target =
      this.state === PS.RESPONDING
        ? this.crimeScene
        : this.waypoints[this.waypointIdx] || null;

    if (!target) return;

    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const spd =
      this.state === PS.RESPONDING ? this.data.speed * 2 : this.data.speed;

    if (d < 1.5) {
      if (this.state === PS.PATROLLING) {
        this.waypointIdx = (this.waypointIdx + 1) % this.waypoints.length;
      } else if (this.state === PS.RESPONDING) {
        this.state = PS.AT_SCENE;
        this.atSceneTimer = 0;
        this.sirenEl.setAttribute('intensity', '1.5');
        if (this.simComp) this.simComp.tryArrest(pos);
      }
    } else {
      pos.x += (dx / d) * spd * dt;
      pos.z += (dz / d) * spd * dt;
      this.el.object3D.rotation.y = Math.atan2(dx, dz);
    }
  }
});

// ── city-simulation ──────────────────────────────────────────────────────────
AFRAME.registerComponent('city-simulation', {
  schema: {
    citizenCount: { type: 'int', default: 15 },
    policeCount: { type: 'int', default: 3 },
    crimeRate: { type: 'number', default: 0.003 },
    citizenSpeed: { type: 'number', default: 1.5 },
    policeSpeed: { type: 'number', default: 8 },
    paused: { type: 'boolean', default: false }
  },

  init() {
    this.citizens = [];
    this.police = [];
    this.pendingCrimes = [];
    this.stats = {
      total: 0,
      resolved: 0,
      avgResponseMs: 0,
      _rtAcc: 0,
      _rtCount: 0
    };

    // Staggered patrol loops so cars don't overlap
    this._PATROL_ROUTES = [
      '-14 -10  14 -10  14  10 -14  10', // outer CW loop
      ' -8  -6   8  -6   8   6  -8   6', // inner CW loop
      '-18   0   0 -14  18   0   0  14' // diagonal X
    ];

    this._CHAR_MIXINS = [
      'a_char1',
      'a_char2',
      'a_char3',
      'a_char4',
      'a_char5',
      'a_char6',
      'a_char7',
      'a_char8'
    ];

    // If scene already loaded (e.g. entity added at runtime), spawn immediately
    if (this.el.sceneEl.hasLoaded) {
      this._spawn();
    } else {
      this.el.sceneEl.addEventListener('loaded', () => this._spawn());
    }
  },

  _spawn() {
    const scene = this.el.sceneEl;

    // Citizens ───────────────────────────────────────────────────────────────
    for (let i = 0; i < this.data.citizenCount; i++) {
      const el = document.createElement('a-entity');
      el.setAttribute('mixin', this._CHAR_MIXINS[i % this._CHAR_MIXINS.length]);
      el.setAttribute('scale', '0.8 0.8 0.8');
      el.setAttribute('position', { x: rand(-15, 15), y: 0, z: rand(-10, 10) });
      el.setAttribute('citizen-agent', {
        speed: this.data.citizenSpeed + rand(-0.3, 0.3),
        crimeRate: this.data.crimeRate
      });
      scene.appendChild(el);

      el.addEventListener('componentinitialized', (e) => {
        if (e.detail.name !== 'citizen-agent') return;
        const comp = el.components['citizen-agent'];
        comp.simComp = this;
        this.citizens.push(comp);
      });
    }

    // Police cars ────────────────────────────────────────────────────────────
    for (let i = 0; i < this.data.policeCount; i++) {
      const el = document.createElement('a-entity');
      el.setAttribute('mixin', 'sedan-rig');
      el.setAttribute('scale', '0.5 0.5 0.5');
      el.setAttribute('police-agent', {
        speed: this.data.policeSpeed,
        route: this._PATROL_ROUTES[i % this._PATROL_ROUTES.length]
      });
      scene.appendChild(el);

      el.addEventListener('componentinitialized', (e) => {
        if (e.detail.name !== 'police-agent') return;
        const comp = el.components['police-agent'];
        comp.simComp = this;
        this.police.push(comp);
      });
    }

    this._broadcast();
  },

  // ── Public: called by citizen-agent ────────────────────────────────────────
  attemptCrime(attacker) {
    if (this.data.paused) return;

    const aPos = attacker.el.object3D.position;

    // Find closest wandering citizen as victim (within 12 units)
    let victim = null;
    let best = Infinity;
    this.citizens.forEach((c) => {
      if (c === attacker || c.state !== CS.WANDERING) return;
      const d = dist2D(c.el.object3D.position, aPos);
      if (d < 12 && d < best) {
        best = d;
        victim = c;
      }
    });
    if (!victim) return;

    // Commit the crime
    attacker.flee();
    victim.die();

    const scene = { x: aPos.x, z: aPos.z, ts: Date.now() };
    this.pendingCrimes.push(scene);
    this.stats.total++;

    this._spawnVFX(aPos, victim.el.object3D.position);
    this._dispatch(scene);
    this._broadcast();
  },

  // ── Public: called by police-agent on arrival ───────────────────────────────
  tryArrest(policePos) {
    this.citizens.forEach((c) => {
      if (
        c.state === CS.FLEEING &&
        dist2D(c.el.object3D.position, policePos) < 8
      ) {
        c.arrest();
      }
    });
  },

  _dispatch(scene) {
    const idle = this.police.filter((p) => p.state === PS.PATROLLING);
    if (!idle.length) return;

    let nearest = idle[0];
    let nearDist = dist2D(idle[0].el.object3D.position, scene);
    idle.slice(1).forEach((p) => {
      const d = dist2D(p.el.object3D.position, scene);
      if (d < nearDist) {
        nearDist = d;
        nearest = p;
      }
    });
    nearest.respondTo(scene);
  },

  _spawnVFX(aPos, vPos) {
    const s = this.el.sceneEl;

    // Red burst at attacker position
    const burst = document.createElement('a-sphere');
    burst.setAttribute('radius', '0.35');
    burst.setAttribute('position', `${aPos.x} 1.6 ${aPos.z}`);
    burst.setAttribute('color', '#ff2200');
    burst.setAttribute(
      'material',
      'opacity:1;emissive:#ff2200;emissiveIntensity:3;transparent:true'
    );
    burst.setAttribute(
      'animation__s',
      'property:scale;to:5 5 5;dur:450;easing:easeOutQuad'
    );
    burst.setAttribute(
      'animation__f',
      'property:material.opacity;to:0;dur:500;easing:easeInQuad'
    );
    s.appendChild(burst);
    setTimeout(() => burst.remove(), 600);

    // Bullet traveling attacker → victim
    const bullet = document.createElement('a-sphere');
    const dur = Math.max(150, dist2D(aPos, vPos) * 65);
    bullet.setAttribute('radius', '0.09');
    bullet.setAttribute('position', `${aPos.x} 1.3 ${aPos.z}`);
    bullet.setAttribute('color', '#ffee00');
    bullet.setAttribute('material', 'emissive:#ffee00;emissiveIntensity:5');
    bullet.setAttribute(
      'animation',
      `property:position;to:${vPos.x} 1.3 ${vPos.z};dur:${dur};easing:linear`
    );
    s.appendChild(bullet);
    setTimeout(() => bullet.remove(), dur + 100);

    // Floating crime label
    const label = document.createElement('a-entity');
    label.setAttribute('position', `${aPos.x} 4 ${aPos.z}`);
    label.setAttribute('look-at', '[camera]');
    label.innerHTML = `
      <a-plane width="2.6" height="0.65" color="#cc0000"
        material="opacity:0.92;transparent:true"
        animation__rise="property:position;to:0 1 0;dur:2500;easing:easeOutQuad"
        animation__fade="property:material.opacity;to:0;dur:2000;delay:800;easing:linear">
      </a-plane>
      <a-text value="⚠ HOMICIDE" color="#ffffff" align="center" width="4" position="0 0 0.02"></a-text>`;
    s.appendChild(label);
    setTimeout(() => label.remove(), 3100);

    // Brief red fill light at crime location
    const flash = document.createElement('a-light');
    flash.setAttribute('type', 'point');
    flash.setAttribute('color', '#ff1100');
    flash.setAttribute('intensity', '4');
    flash.setAttribute('distance', '12');
    flash.setAttribute('position', `${aPos.x} 2 ${aPos.z}`);
    flash.setAttribute(
      'animation',
      'property:light.intensity;to:0;dur:1500;easing:easeInQuad'
    );
    s.appendChild(flash);
    setTimeout(() => flash.remove(), 1600);
  },

  _broadcast() {
    const { total, resolved, avgResponseMs } = this.stats;
    window.dispatchEvent(
      new CustomEvent('city-stats', {
        detail: {
          total,
          resolved,
          pending: this.pendingCrimes.length,
          avgResponseMs: Math.round(avgResponseMs),
          policeCount: this.data.policeCount
        }
      })
    );
  },

  tick() {
    if (this.data.paused) return;

    // Resolve crimes where any police car is currently AT_SCENE nearby
    this.pendingCrimes = this.pendingCrimes.filter((crime) => {
      const resolved = this.police.some(
        (p) =>
          p.state === PS.AT_SCENE && dist2D(p.el.object3D.position, crime) < 6
      );
      if (resolved) {
        this.stats.resolved++;
        if (crime.ts) {
          const rt = Date.now() - crime.ts;
          this.stats._rtAcc += rt;
          this.stats._rtCount += 1;
          this.stats.avgResponseMs = this.stats._rtAcc / this.stats._rtCount;
        }
        this._broadcast();
        return false;
      }
      return true;
    });
  }
});
