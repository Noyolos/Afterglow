import * as THREE from "three";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

class CalendarVolumetricBackground {
  constructor(canvas) {
    this.canvas = canvas || null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.rayMaterial = null;
    this.dustMaterial = null;
    this.rafId = 0;
    this.running = false;
    this.clock = new THREE.Clock();
    this.targetOriginX = -0.2;
    this.targetOriginY = 1.2;
    this._boundResize = () => this._onResize();
    this._boundMouseMove = (event) => this._onMouseMove(event);
  }

  _createRayMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uLightOrigin: { value: new THREE.Vector2(-0.2, 1.2) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.999, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec2 uResolution;
        uniform vec2 uLightOrigin;
        varying vec2 vUv;

        float hash(vec2 p) {
          return fract(1e4 * sin(17.0 * p.x + p.y * 0.1) * (0.1 + abs(sin(p.y * 13.0 + p.x))));
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                     mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
        }

        float fbm(vec2 p) {
          float f = 0.0;
          f += 0.5000 * noise(p); p = p * 2.02;
          f += 0.2500 * noise(p); p = p * 2.03;
          f += 0.1250 * noise(p); p = p * 2.01;
          return f / 0.875;
        }

        void main() {
          vec2 uv = vUv;
          vec2 dir = uv - uLightOrigin;
          vec2 dirAspect = dir;
          dirAspect.x *= uResolution.x / max(uResolution.y, 1.0);
          float dist = length(dirAspect);
          float angle = atan(dirAspect.y, dirAspect.x);

          float beams = fbm(vec2(angle * 8.0, uTime * 0.08));
          beams *= fbm(vec2(angle * 22.0, -uTime * 0.05));
          beams = pow(beams, 1.3);

          float fog = fbm(uv * 4.0 - dir * uTime * 0.08);
          float volumetricLight = beams * (fog * 0.8 + 0.4);
          float attenuation = smoothstep(2.5, 0.1, dist);
          volumetricLight *= attenuation;

          vec3 bgColor = vec3(0.01, 0.01, 0.02);
          vec3 coreColor = vec3(1.0, 1.0, 1.0);
          vec3 rayColorWarm = vec3(0.9, 0.92, 0.98);
          vec3 rayColorCold = vec3(0.5, 0.55, 0.65);
          vec3 finalRayColor = mix(rayColorCold, rayColorWarm, smoothstep(1.8, 0.3, dist));
          finalRayColor = mix(finalRayColor, coreColor, smoothstep(0.4, 0.0, dist));

          float glow = exp(-dist * 3.5);
          vec3 finalColor = bgColor + (finalRayColor * volumetricLight * 2.2) + (coreColor * glow * 0.4);

          gl_FragColor = vec4(finalColor, 1.0);
        }
      `,
      depthWrite: false,
    });
  }

  _createDustPoints() {
    const dustCount = 640;
    const dustGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(dustCount * 3);
    const phases = new Float32Array(dustCount);

    for (let i = 0; i < dustCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 2.2;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 2.2;
      positions[i * 3 + 2] = 0;
      phases[i] = Math.random() * Math.PI * 2;
    }
    dustGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    dustGeo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));

    this.dustMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        uniform float uTime;
        attribute float aPhase;
        varying float vAlpha;
        void main() {
          vec3 pos = position;
          pos.y += uTime * 0.03;
          pos.x += sin(uTime * 0.2 + aPhase) * 0.02;
          pos.y = fract((pos.y + 1.1) / 2.2) * 2.2 - 1.1;
          gl_PointSize = (2.0 + sin(uTime * 1.5 + aPhase) * 1.5);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
          vAlpha = sin(uTime * 0.8 + aPhase) * 0.5 + 0.5;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          float dist = distance(gl_PointCoord, vec2(0.5));
          if (dist > 0.5) discard;
          float alpha = smoothstep(0.5, 0.2, dist);
          gl_FragColor = vec4(0.9, 0.95, 1.0, alpha * vAlpha * 0.6);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    return new THREE.Points(dustGeo, this.dustMaterial);
  }

  _ensureReady() {
    if (!this.canvas || this.renderer) return;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    const quad = new THREE.PlaneGeometry(2, 2);
    this.rayMaterial = this._createRayMaterial();
    const rayMesh = new THREE.Mesh(quad, this.rayMaterial);
    rayMesh.frustumCulled = false;
    this.scene.add(rayMesh);
    this.scene.add(this._createDustPoints());
  }

  _onMouseMove(event) {
    const mouseX = (event.clientX / window.innerWidth) * 2 - 1;
    const mouseY = -(event.clientY / window.innerHeight) * 2 + 1;
    this.targetOriginX = -0.2 + mouseX * 0.15;
    this.targetOriginY = 1.2 + mouseY * 0.15;
  }

  _onResize() {
    if (!this.renderer || !this.rayMaterial) return;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.rayMaterial.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
  }

  _animate = () => {
    if (!this.running || !this.renderer || !this.rayMaterial || !this.dustMaterial) return;
    const elapsed = this.clock.getElapsedTime();
    this.rayMaterial.uniforms.uTime.value = elapsed;
    this.dustMaterial.uniforms.uTime.value = elapsed;

    const origin = this.rayMaterial.uniforms.uLightOrigin.value;
    origin.x += (this.targetOriginX - origin.x) * 0.05;
    origin.y += (this.targetOriginY - origin.y) * 0.05;

    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this._animate);
  };

  start() {
    if (this.running || !this.canvas) return;
    this._ensureReady();
    if (!this.renderer) return;
    this.running = true;
    this.clock.start();
    window.addEventListener("resize", this._boundResize);
    window.addEventListener("mousemove", this._boundMouseMove);
    this.rafId = requestAnimationFrame(this._animate);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    window.removeEventListener("resize", this._boundResize);
    window.removeEventListener("mousemove", this._boundMouseMove);
  }
}

export class MemoryCalendar {
  constructor() {
    this.container = document.getElementById("calendar-days");
    this.card = document.getElementById("calendar-card");
    this.monthLabel = document.getElementById("calendar-month-year");
    this.view = document.getElementById("view-calendar");
    this.selectedDateKey = "";
    this.currentYear = 0;
    this.currentMonth = 0;
    this.onDateSelect = null;
    this.pendingSelectionResolve = null;
    this.pendingSelectionTimer = null;
    this.background = new CalendarVolumetricBackground(document.getElementById("calendar-webgl-bg"));

    this._bindEvents();
  }

  _bindEvents() {
    if (!this.container) return;
    this.container.addEventListener("click", (event) => {
      const cell = event.target?.closest?.(".date-cell[data-date]");
      if (!cell) return;
      const dateKey = cell.getAttribute("data-date");
      this.selectDate(dateKey);
    });
  }

  _buildDateKey(year, month, day) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  _isKeyInMonth(dateKey, year, month) {
    if (!dateKey) return false;
    return dateKey.startsWith(`${year}-${String(month).padStart(2, "0")}-`);
  }

  _updateActiveState() {
    if (!this.container) return;
    const cells = this.container.querySelectorAll(".date-cell[data-date]");
    cells.forEach((cell) => {
      const key = cell.getAttribute("data-date");
      cell.classList.toggle("active-day", key === this.selectedDateKey);
    });
  }

  render(year, month, historicalCounts = {}, preferredDateKey = "") {
    if (!this.container || !this.monthLabel) return;
    this.currentYear = year;
    this.currentMonth = month;

    this.container.innerHTML = "";
    this.monthLabel.textContent = `${MONTH_NAMES[month - 1]} ${year}`;

    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
      this.container.insertAdjacentHTML("beforeend", `<div></div>`);
    }

    const today = new Date();
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
    const currentDay = today.getDate();
    const todayKey = this._buildDateKey(year, month, currentDay);
    let activeKey = "";
    if (this._isKeyInMonth(preferredDateKey, year, month)) activeKey = preferredDateKey;
    else if (this._isKeyInMonth(this.selectedDateKey, year, month)) activeKey = this.selectedDateKey;
    else if (isCurrentMonth) activeKey = todayKey;
    else activeKey = this._buildDateKey(year, month, 1);
    this.selectedDateKey = activeKey;

    for (let day = 1; day <= daysInMonth; day++) {
      const key = this._buildDateKey(year, month, day);
      const count = Number(historicalCounts[key] || 0);
      const isToday = isCurrentMonth && day === currentDay;
      const isActive = key === this.selectedDateKey;
      const dots = Array.from({ length: Math.max(0, count) })
        .map(() => `<div class="memory-dot"></div>`)
        .join("");

      this.container.insertAdjacentHTML(
        "beforeend",
        `
          <div class="date-cell ${isActive ? "active-day" : ""}" id="day-${day}" data-date="${key}">
            <span class="date-num ${isToday ? "is-today" : ""}">${day}</span>
            <div class="date-dots" id="dots-${day}">
              ${dots}
            </div>
          </div>
        `
      );
    }
  }

  setOnDateSelect(handler) {
    this.onDateSelect = typeof handler === "function" ? handler : null;
  }

  getSelectedDateKey() {
    return this.selectedDateKey || "";
  }

  selectDate(dateKey) {
    if (!dateKey) return;
    this.selectedDateKey = dateKey;
    this._updateActiveState();
    if (this.onDateSelect) this.onDateSelect(dateKey);
    if (this.pendingSelectionResolve) {
      const resolve = this.pendingSelectionResolve;
      this.pendingSelectionResolve = null;
      if (this.pendingSelectionTimer) {
        window.clearTimeout(this.pendingSelectionTimer);
        this.pendingSelectionTimer = null;
      }
      resolve(dateKey);
    }
  }

  waitForDateSelection({ timeoutMs = 120000, defaultDateKey = "" } = {}) {
    if (defaultDateKey) this.selectDate(defaultDateKey);
    if (this.pendingSelectionResolve) {
      return new Promise((resolve) => {
        const previous = this.pendingSelectionResolve;
        this.pendingSelectionResolve = (value) => {
          previous(value);
          resolve(value);
        };
      });
    }
    return new Promise((resolve) => {
      this.pendingSelectionResolve = resolve;
      if (timeoutMs > 0) {
        this.pendingSelectionTimer = window.setTimeout(() => {
          const fallback = this.selectedDateKey || defaultDateKey || "";
          if (this.pendingSelectionResolve) {
            const done = this.pendingSelectionResolve;
            this.pendingSelectionResolve = null;
            done(fallback);
          }
          this.pendingSelectionTimer = null;
        }, timeoutMs);
      }
    });
  }

  playPinAnimation(dateKey = "") {
    return new Promise((resolve) => {
      if (dateKey) this.selectDate(dateKey);
      const selected = this.selectedDateKey || dateKey;
      if (!selected) {
        resolve();
        return;
      }
      const today = Number(selected.split("-")[2] || 0);
      const dotsContainer = document.getElementById(`dots-${today}`);
      if (!dotsContainer) {
        resolve();
        return;
      }

      const newDot = document.createElement("div");
      newDot.className = "memory-dot opacity-0";
      dotsContainer.appendChild(newDot);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          newDot.classList.remove("opacity-0");
          newDot.classList.add("pin-drop-active");

          if (this.card) {
            window.setTimeout(() => {
              this.card.classList.remove("shake-active");
              void this.card.offsetWidth;
              this.card.classList.add("shake-active");
            }, 200);
          }

          window.setTimeout(resolve, 1000);
        });
      });
    });
  }

  show() {
    if (!this.view) return;
    this.setBackgroundOnly(false);
    this.background.start();
    this.view.classList.remove("view-hidden");
    this.view.classList.add("view-visible");
    this.view.setAttribute("aria-hidden", "false");
  }

  setBackgroundOnly(isBackgroundOnly) {
    if (!this.view) return;
    const enabled = Boolean(isBackgroundOnly);
    this.view.classList.toggle("calendar-background-only", enabled);
    if (this.card) this.card.setAttribute("aria-hidden", enabled ? "true" : "false");
  }

  hide() {
    if (!this.view) return;
    this.setBackgroundOnly(false);
    this.background.stop();
    this.view.classList.remove("view-visible");
    this.view.classList.add("view-hidden");
    this.view.setAttribute("aria-hidden", "true");
  }
}
