'use strict';
const state = {
  turnsLeft:  47,
  turnsErr:   9,
  spent:      0.12,
  vetoes:     2,
  drift:      0,
  p99Vals:    [28, 47, 132],
  p99Idx:     0,
  elapsed:    0,       // ms
  paused:     false,
  lastTick:   null,
  activePlugin: null,  // name string or null
  phaseIdx:   -1,      // -1 = idle
  phaseTimer: null,
  stressTimer: null,
  eventTs:    0.001,   // rolling timestamp for events
};

const phases = ['anchor', 'trust-gate', 'pre-disp', 'dispatch', 'post-resp', 'post-sess', 'cross-sess'];

// Fix #3: one key metric per plugin (initial values)
const PLUGINS = [
  { name: 'pech',   color: '#b36a2e', meta: '$0.12' },
  { name: 'hydra',  color: '#6bb04a', meta: '2 vetoes  last: h-rm-rf-root' },
  { name: 'sylph',  color: '#4ec8e5', meta: '1 blocked' },
  { name: 'djinn',  color: '#3d5ac4', meta: 'on task ✓' },
  { name: 'emu',    color: '#c9925e', meta: '47 ± 9 turns' },
];

const sparkBuffers = {};
PLUGINS.forEach(p => {
  sparkBuffers[p.name] = Array.from({length: 12}, () => Math.random() * 0.6 + 0.1);
});

const $elapsed      = document.getElementById('elapsed');
const $turnsVal     = document.getElementById('turns-val');
const $turnsErr     = document.getElementById('turns-err');
const $spentVal     = document.getElementById('spent-val');
const $vetoVal      = document.getElementById('veto-val');
const $driftVal     = document.getElementById('drift-val');
const $p99Val       = document.getElementById('p99-val');
const $eventsPanel  = document.getElementById('events-list');
const $phaseSegs    = document.querySelectorAll('.phase-seg');
const $cardTurns    = document.getElementById('card-turns');
const $cardSpent    = document.getElementById('card-spent');
const $cardSec      = document.getElementById('card-sec');
const $cardDrift    = document.getElementById('card-drift');
const $cardP99      = document.getElementById('card-p99');
const $pauseBtn     = document.getElementById('btn-pause');
const $demoBtn      = document.getElementById('btn-demo');
const $stressBtn    = document.getElementById('btn-stress');
const $window       = document.getElementById('window');

const canvases = {};
PLUGINS.forEach(p => {
  canvases[p.name] = document.getElementById('canvas-' + p.name);
});

function fmt(ms) {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2,'0');
  const ss = String(total % 60).padStart(2,'0');
  const mmm = String(Math.floor(ms % 1000)).padStart(3,'0');
  return `${mm}:${ss}.${mmm}`;
}

function nextTs() {
  state.eventTs += Math.random() * 0.08 + 0.02;
  return state.eventTs.toFixed(3);
}

function pushEvent(name, cls) {
  const ts = nextTs();
  const row = document.createElement('div');
  row.className = 'event-row';
  row.innerHTML = `<span class="event-ts">${ts}</span><span class="event-name ${cls||''}">${name}</span>`;
  $eventsPanel.prepend(row);
  // keep at most 30 events
  while ($eventsPanel.children.length > 30) {
    $eventsPanel.removeChild($eventsPanel.lastChild);
  }
}

function updateDisplay() {
  $turnsVal.textContent  = state.turnsLeft;
  $turnsErr.textContent  = `± ${state.turnsErr}`;
  $spentVal.textContent  = `$${state.spent.toFixed(2)}`;
  $vetoVal.textContent   = `${state.vetoes} vetoes`;
  $driftVal.textContent  = state.drift;
  $p99Val.textContent    = `${state.p99Vals[state.p99Idx]}ms`;
}

function drawSparkline(name, color, fast) {
  const canvas = canvases[name];
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const buf = sparkBuffers[name];
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const barW = Math.floor(W / buf.length) - 1;
  buf.forEach((v, i) => {
    const barH = Math.max(1, Math.round(v * H));
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(i * (barW + 1), H - barH, barW, barH);
  });
  ctx.globalAlpha = 1;
}

function tickSparklines(fastPlugin) {
  PLUGINS.forEach(p => {
    const buf = sparkBuffers[p.name];
    let newVal;
    if (p.name === fastPlugin) {
      newVal = Math.min(1, Math.random() * 0.5 + 0.5);
    } else {
      const last = buf[buf.length - 1];
      newVal = Math.max(0.05, Math.min(1, last + (Math.random() - 0.5) * 0.2));
    }
    buf.shift();
    buf.push(newVal);
    drawSparkline(p.name, p.color, p.name === fastPlugin);
  });
}

let lastSparkTick = 0;
function rafLoop(ts) {
  requestAnimationFrame(rafLoop);
  if (!state.paused && ts - lastSparkTick > 200) {
    tickSparklines(state.activePlugin);
    lastSparkTick = ts;
  }
}
requestAnimationFrame(rafLoop);

function timerTick() {
  if (!state.paused) {
    state.elapsed += 100;
    if ($elapsed) $elapsed.textContent = 'elapsed=' + fmt(state.elapsed);
  }
}
setInterval(timerTick, 100);

$cardTurns?.addEventListener('click', () => {
  if (state.turnsLeft > 0) state.turnsLeft--;
  pushEvent('emu.runway', '');
  updateDisplay();
});

$cardSpent?.addEventListener('click', () => {
  state.spent += (Math.random() * 0.04 + 0.01);
  pushEvent('billing.increment', '');
  updateDisplay();
});

$cardSec?.addEventListener('click', () => {
  state.vetoes++;
  pushEvent('hydra.veto', 'veto');
  $cardSec.classList.add('veto-flash');
  setTimeout(() => $cardSec.classList.remove('veto-flash'), 1200);
  // Fix #3: hydra key metric = vetoes count
  const metaHydra = document.getElementById('meta-hydra');
  if (metaHydra) metaHydra.textContent = `${state.vetoes} vetoes  last: h-rm-rf-root`;
  updateDisplay();
});

$cardDrift?.addEventListener('click', () => {
  state.drift++;
  pushEvent('djinn.drift.detected', 'drift');
  // Fix #3: djinn key metric is drift state
  const metaDjinn = document.getElementById('meta-djinn');
  if (metaDjinn) {
    metaDjinn.textContent = state.drift > 0 ? 'drift detected ⚠' : 'on task ✓';
    metaDjinn.style.color = state.drift > 0 ? 'var(--amber)' : '';
  }
  updateDisplay();
});

$cardP99?.addEventListener('click', () => {
  state.p99Idx = (state.p99Idx + 1) % state.p99Vals.length;
  pushEvent('perf.p99.change', '');
  updateDisplay();
});

document.querySelectorAll('.plugin-row').forEach(row => {
  row.addEventListener('click', () => {
    const name = row.dataset.plugin;
    if (state.activePlugin === name) {
      // clear
      state.activePlugin = null;
      row.classList.remove('active');
      // restore all events visibility
      document.querySelectorAll('.event-row').forEach(e => e.style.display = '');
    } else {
      // deactivate old
      document.querySelectorAll('.plugin-row.active').forEach(r => r.classList.remove('active'));
      state.activePlugin = name;
      row.classList.add('active');
      // filter events panel
      filterEvents(name);
      // fast-sparkline for 2s
      const orig = state.activePlugin;
      setTimeout(() => {
        if (state.activePlugin === orig) state.activePlugin = null;
        document.querySelectorAll('.plugin-row.active').forEach(r => r.classList.remove('active'));
        document.querySelectorAll('.event-row').forEach(e => e.style.display = '');
      }, 2000);
    }
  });
});

function filterEvents(plugin) {
  document.querySelectorAll('.event-row').forEach(e => {
    const name = e.querySelector('.event-name')?.textContent || '';
    e.style.display = name.startsWith(plugin) ? '' : 'none';
  });
}

function resetPhases() {
  $phaseSegs.forEach(s => {
    s.classList.remove('done', 'current');
    s.querySelector('.phase-icon').textContent = '○';
  });
}

function setPhase(idx) {
  $phaseSegs.forEach((s, i) => {
    s.classList.remove('done', 'current');
    const icon = s.querySelector('.phase-icon');
    if (i < idx) { s.classList.add('done'); icon.textContent = '✓'; }
    else if (i === idx) { s.classList.add('current'); icon.textContent = '●'; }
    else { icon.textContent = '○'; }
  });
}

const demoEvents = [
  ['pech.tool.call', ''],
  ['djinn.anchor.set', 'anchor'],
  ['hydra.trust-gate.open', ''],
  ['sylph.pre-dispatch', ''],
  ['pech.dispatch', ''],
  ['sylph.post-resp', ''],
  ['djinn.post-sess', 'anchor'],
  ['hydra.cross-sess.sync', ''],
];

$demoBtn?.addEventListener('click', () => {
  if (state.phaseTimer) return;
  resetPhases();
  let i = 0;
  state.phaseIdx = 0;
  const tick = () => {
    if (i >= phases.length) {
      state.phaseIdx = -1;
      state.phaseTimer = null;
      $demoBtn.classList.remove('active');
      return;
    }
    setPhase(i);
    if (demoEvents[i]) pushEvent(...demoEvents[i]);
    i++;
    state.phaseTimer = setTimeout(tick, 420);
  };
  $demoBtn.classList.add('active');
  tick();
});

const stressEvents = [
  ['hydra.veto.rm-rf', 'veto'],
  ['hydra.veto.curl-pipe', 'veto'],
  ['sylph.destructive.blocked', 'veto'],
  ['hydra.veto.sudo-dd', 'veto'],
  ['pech.attack.prompt-inject', 'veto'],
  ['djinn.drift.detected', 'drift'],
  ['hydra.veto.env-exfil', 'veto'],
  ['sylph.destructive.attempt', 'veto'],
  ['hydra.veto.npm-postinstall', 'veto'],
  ['pech.attack.loop-bomb', 'veto'],
  ['djinn.drift.recovery', 'anchor'],
  ['hydra.veto.git-force-push', 'veto'],
  ['hydra.veto.chown-root', 'veto'],
  ['sylph.harden.complete', 'anchor'],
];

$stressBtn?.addEventListener('click', () => {
  if (state.stressTimer) return;
  const origVetoes = state.vetoes;
  let i = 0;
  $stressBtn.classList.add('active');

  const tick = () => {
    if (i >= stressEvents.length) {
      state.stressTimer = null;
      $stressBtn.classList.remove('active');
      return;
    }
    const [name, cls] = stressEvents[i];
    pushEvent(name, cls);
    if (cls === 'veto') {
      state.vetoes++;
      $cardSec.classList.add('veto-flash');
      setTimeout(() => $cardSec.classList.remove('veto-flash'), 400);
    }
    if (cls === 'drift') state.drift++;
    updateDisplay();
    // spike all sparklines
    PLUGINS.forEach(p => {
      const buf = sparkBuffers[p.name];
      buf.shift();
      buf.push(Math.min(1, Math.random() * 0.4 + 0.6));
    });
    i++;
    state.stressTimer = setTimeout(tick, 430);
  };
  tick();
});

$pauseBtn?.addEventListener('click', () => {
  state.paused = !state.paused;
  $pauseBtn.textContent = state.paused ? '[ Resume ]' : '[ Pause ]';
  $pauseBtn.classList.toggle('active', state.paused);
});

function tempAnim(cls, ms) {
  $window.classList.add(cls);
  setTimeout(() => $window.classList.remove(cls), ms);
}

document.querySelector('.dot.red')?.addEventListener('click',    () => tempAnim('anim-close',    500));
document.querySelector('.dot.green')?.addEventListener('click',  () => tempAnim('anim-zoom',     500));
document.querySelector('.dot.yellow')?.addEventListener('click', () => tempAnim('anim-minimize', 500));

updateDisplay();
PLUGINS.forEach(p => drawSparkline(p.name, p.color, false));

// Seed a few initial events
const initEvents = [
  ['pech.tool.call', ''],
  ['hydra.veto', 'veto'],
  ['sylph.destructive', 'drift'],
  ['djinn.anchor', 'anchor'],
  ['emu.runway', ''],
];
initEvents.reverse().forEach(([n, c]) => pushEvent(n, c));
