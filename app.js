(() => {
  'use strict';

  /* ---------- helpers ---------- */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mmss = (sec) => {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  /* ---------- constants ---------- */
  const KEY = { settings: 'tabata.settings.v1', history: 'tabata.history.v1' };
  const PRESETS = {
    full: ['점핑잭', '버피', '마운틴 클라이머', '스쿼트 점프', '하이니', '플랭크 잭', '스케이터', '푸시업'],
    lower: ['스쿼트', '런지 (왼쪽)', '런지 (오른쪽)', '스쿼트 점프', '글루트 브릿지', '월싯', '카프 레이즈', '스케이터'],
    upper: ['푸시업', '플랭크', '마운틴 클라이머', '바이시클 크런치', '슈퍼맨', '다이아몬드 푸시업', '레그 레이즈', '플랭크 숄더탭'],
  };
  const DEFAULTS = { work: 20, rest: 10, rounds: 8, warmup: 10, goal: 3, preset: 'full', custom: '', sound: true, vibrate: true };
  const LIMITS = { work: [5, 120, 5], rest: [0, 120, 5], rounds: [1, 20, 1], warmup: [0, 30, 5], goal: [1, 7, 1] };
  const RING_C = 2 * Math.PI * 90;

  /* ---------- storage ---------- */
  const load = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경은 무시 */ } };

  const settings = Object.assign({}, DEFAULTS, load(KEY.settings, {}));
  for (const k of Object.keys(LIMITS)) {
    const [lo, hi] = LIMITS[k];
    settings[k] = clamp(Number(settings[k]) || DEFAULTS[k], lo, hi);
  }
  if (!['full', 'lower', 'upper', 'custom'].includes(settings.preset)) settings.preset = 'full';
  let history = load(KEY.history, []);
  if (!Array.isArray(history)) history = [];
  const saveSettings = () => save(KEY.settings, settings);
  const saveHistory = () => save(KEY.history, history);

  /* ---------- exercises & phases ---------- */
  function exercises() {
    if (settings.preset === 'custom') {
      const l = String(settings.custom).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20);
      if (l.length) return l;
    }
    return PRESETS[settings.preset] || PRESETS.full;
  }

  function buildPhases() {
    const ex = exercises();
    const list = [];
    const { work, rest, rounds, warmup } = settings;
    if (warmup > 0) list.push({ type: 'warmup', dur: warmup, exercise: ex[0], round: 0 });
    for (let r = 1; r <= rounds; r++) {
      list.push({ type: 'work', dur: work, exercise: ex[(r - 1) % ex.length], round: r });
      if (r < rounds && rest > 0) list.push({ type: 'rest', dur: rest, exercise: ex[r % ex.length], round: r });
    }
    return list;
  }
  const totalSeconds = () => settings.warmup + settings.rounds * settings.work + Math.max(0, settings.rounds - 1) * settings.rest;

  /* ---------- audio / vibration / wake lock ---------- */
  let ctx = null;
  function initAudio() {
    if (!settings.sound) return;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch { ctx = null; }
  }
  function beep(freq, dur = 0.12, vol = 0.25, delay = 0) {
    if (!settings.sound || !ctx) return;
    try {
      const t = ctx.currentTime + delay;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    } catch { /* 소리 재생 실패는 무시 */ }
  }
  function vibrate(p) { if (settings.vibrate && navigator.vibrate) { try { navigator.vibrate(p); } catch { /* noop */ } } }

  let wakeLock = null;
  async function requestLock() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { wakeLock = null; } }
  function releaseLock() { try { if (wakeLock) wakeLock.release(); } catch { /* noop */ } wakeLock = null; }

  /* ---------- run engine ---------- */
  const run = { active: false, paused: false, phases: [], prefix: [], total: 0, i: 0, endsAt: 0, remaining: 0, lastSec: null, timer: null, startedAt: 0 };

  function setPanel(name) {
    for (const p of ['setup', 'run', 'done']) $('#panel-' + p).hidden = p !== name;
    if (name === 'setup') document.body.dataset.phase = 'idle';
    if (name === 'done') document.body.dataset.phase = 'done';
  }

  function startWorkout() {
    initAudio();
    const phases = buildPhases();
    let acc = 0;
    run.prefix = phases.map((p) => { const s = acc; acc += p.dur; return s; });
    run.total = acc;
    run.phases = phases;
    run.i = 0;
    run.active = true;
    run.paused = false;
    run.startedAt = Date.now();
    $('#btn-pause').textContent = '일시정지';
    resetStopButton();
    setPanel('run');
    enterPhase(0, Date.now());
    requestLock();
    clearInterval(run.timer);
    run.timer = setInterval(tick, 100);
    tick();
  }

  function enterPhase(i, startAt) {
    const p = run.phases[i];
    run.endsAt = startAt + p.dur * 1000;
    run.lastSec = null;
    renderPhase(p);
    if (p.type === 'work') { beep(880, 0.35, 0.3); vibrate(220); }
    else if (p.type === 'rest') { beep(440, 0.25, 0.25); vibrate([80, 40, 80]); }
  }

  function tick() {
    if (!run.active || run.paused) return;
    const now = Date.now();
    while (now >= run.endsAt) {
      if (run.i >= run.phases.length - 1) { finish(true); return; }
      run.i++;
      enterPhase(run.i, run.endsAt); // 이전 종료 시각 기준으로 이어 붙여 오차 누적 방지
    }
    renderTime(run.endsAt - now);
  }

  function renderPhase(p) {
    document.body.dataset.phase = p.type;
    const label = { warmup: '준비', work: '운동', rest: '휴식' }[p.type];
    $('#phase-label').textContent = label;
    $('#exercise').textContent = p.type === 'rest' ? '휴식' : p.exercise;
    const last = p.type === 'work' && p.round === settings.rounds;
    let next = '';
    if (p.type === 'warmup') next = '첫 동작 · ' + p.exercise;
    else if (p.type === 'work') {
      const nw = run.phases.slice(run.i + 1).find((x) => x.type === 'work');
      next = last || !nw ? '마지막 라운드! 끝까지!' : '다음 동작 · ' + nw.exercise;
    }
    else next = '다음 동작 · ' + p.exercise;
    $('#next-up').textContent = next;
    $('#run-round').textContent = p.round === 0 ? '준비 중' : '라운드 ' + p.round + ' / ' + settings.rounds;
    $('#dots').innerHTML = Array.from({ length: settings.rounds }, (_, k) => {
      const r = k + 1;
      const cls = (p.type === 'rest' && r <= p.round) || (p.type === 'work' && r < p.round) ? 'done' : (p.type === 'work' && r === p.round ? 'cur' : '');
      return '<i class="' + cls + '"></i>';
    }).join('');
  }

  function renderTime(remMs) {
    const p = run.phases[run.i];
    const sec = Math.ceil(remMs / 1000);
    if (sec !== run.lastSec) {
      run.lastSec = sec;
      $('#time').textContent = mmss(sec);
      if (sec >= 1 && sec <= 3) { beep(660, 0.1, 0.22); vibrate(40); }
      const elapsed = run.prefix[run.i] + p.dur - sec;
      $('#run-remaining').textContent = '남은 시간 ' + mmss(run.total - elapsed);
    }
    $('#ring-fg').style.strokeDashoffset = String(RING_C * (1 - remMs / (p.dur * 1000)));
    const elapsedMs = run.prefix[run.i] * 1000 + (p.dur * 1000 - remMs);
    $('#overall-bar').style.width = clamp((elapsedMs / (run.total * 1000)) * 100, 0, 100) + '%';
  }

  function togglePause() {
    if (!run.active) return;
    if (!run.paused) {
      run.remaining = Math.max(0, run.endsAt - Date.now());
      run.paused = true;
      $('#btn-pause').textContent = '계속';
      $('#phase-label').textContent = '일시정지';
    } else {
      run.endsAt = Date.now() + run.remaining;
      run.paused = false;
      $('#btn-pause').textContent = '일시정지';
      $('#phase-label').textContent = { warmup: '준비', work: '운동', rest: '휴식' }[run.phases[run.i].type];
      requestLock();
    }
  }

  let stopArmTimer = null;
  function resetStopButton() { clearTimeout(stopArmTimer); stopArmTimer = null; const b = $('#btn-stop'); b.textContent = '종료'; b.classList.remove('danger'); }
  function onStopClick() {
    if (stopArmTimer) { resetStopButton(); finish(false); return; }
    const b = $('#btn-stop');
    b.textContent = '한 번 더 누르면 종료';
    b.classList.add('danger');
    stopArmTimer = setTimeout(resetStopButton, 3000);
  }

  function finish(completed) {
    clearInterval(run.timer);
    run.active = false;
    releaseLock();
    resetStopButton();
    const rem = completed ? 0 : (run.paused ? run.remaining : Math.max(0, run.endsAt - Date.now()));
    const cur = run.phases[run.i];
    const doneRounds = run.phases.filter((p, idx) => p.type === 'work' && (idx < run.i || (idx === run.i && completed))).length;
    const totalSec = Math.round(run.prefix[run.i] + (cur.dur - rem / 1000));
    run.paused = false;

    if (completed) {
      beep(660, 0.15, 0.3); beep(880, 0.15, 0.3, 0.18); beep(1175, 0.4, 0.3, 0.36); vibrate([200, 80, 200, 80, 400]);
    }
    if (doneRounds < 1) { setPanel('setup'); renderSetup(); return; }

    history.unshift({
      id: Date.now(),
      at: new Date().toISOString(),
      work: settings.work, rest: settings.rest, rounds: settings.rounds,
      doneRounds, workSec: doneRounds * settings.work, totalSec, completed,
    });
    history = history.slice(0, 500);
    saveHistory();

    $('#done-title').textContent = completed ? '운동 완료!' : '수고했어요!';
    $('#done-msg').textContent = completed ? '모든 라운드를 끝냈습니다. 기록이 저장되었습니다.' : doneRounds + '/' + settings.rounds + ' 라운드까지 기록되었습니다.';
    $('#done-rounds').textContent = String(doneRounds);
    $('#done-work').textContent = mmss(doneRounds * settings.work);
    $('#done-week').textContent = String(weekSessions());
    setPanel('done');
  }

  /* ---------- setup rendering ---------- */
  function renderSetup() {
    for (const k of ['work', 'rest', 'rounds', 'warmup', 'goal']) { const el = $('#val-' + k); if (el) el.textContent = String(settings[k]); }
    $('#total-time').textContent = mmss(totalSeconds());
    $$('#preset-seg button').forEach((b) => b.classList.toggle('on', b.dataset.preset === settings.preset));
    $('#custom-wrap').hidden = settings.preset !== 'custom';
    const ex = exercises();
    $('#ex-preview').innerHTML = Array.from({ length: settings.rounds }, (_, i) => '<li>' + esc(ex[i % ex.length]) + '</li>').join('');
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- records ---------- */
  const dayKey = (d) => d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  function weekStart() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
  function weekSessions() { const s = weekStart().getTime(); return history.filter((h) => new Date(h.at).getTime() >= s).length; }

  function streak() {
    const days = new Set(history.map((h) => dayKey(new Date(h.at))));
    const d = new Date();
    if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  function renderRecords() {
    const wk = weekSessions();
    $('#goal-count').textContent = String(wk);
    $('#goal-target').textContent = String(settings.goal);
    $('#goal-bar').style.width = clamp((wk / settings.goal) * 100, 0, 100) + '%';
    $('#goal-msg').textContent = wk >= settings.goal ? '목표 달성!' : (settings.goal - wk) + '회 남음';
    $('#stat-sessions').textContent = String(history.length);
    $('#stat-minutes').textContent = String(Math.round(history.reduce((a, h) => a + (h.workSec || 0), 0) / 60));
    $('#stat-streak').textContent = String(streak());

    const names = ['일', '월', '화', '수', '목', '금', '토'];
    const days = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); days.push(d); }
    const mins = days.map((d) => history.filter((h) => dayKey(new Date(h.at)) === dayKey(d)).reduce((a, h) => a + (h.workSec || 0), 0) / 60);
    const max = Math.max(4, ...mins);
    $('#week-chart').innerHTML = days.map((d, i) => {
      const v = mins[i];
      const label = v === 0 ? '0' : (Math.round(v * 10) / 10).toString();
      return '<div class="wc"><em>' + label + '</em><div class="col' + (v === 0 ? ' zero' : '') + '" style="height:' + (v / max) * 80 + '%"></div><small>' + names[d.getDay()] + '</small></div>';
    }).join('');

    const fmt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    $('#history').innerHTML = history.slice(0, 30).map((h) =>
      '<li><div class="h-main"><b>' + h.doneRounds + '/' + h.rounds + ' 라운드 · ' + h.work + '초/' + h.rest + '초' +
      (h.completed ? '' : '<span class="tag">중단</span>') + '</b><span>' + fmt.format(new Date(h.at)) + ' · ' + mmss(h.totalSec) + '</span></div>' +
      '<button type="button" class="h-del" data-id="' + h.id + '" aria-label="기록 삭제">×</button></li>').join('');
    $('#history-empty').hidden = history.length > 0;
  }

  /* ---------- navigation ---------- */
  function showView(name) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
    if (name === 'records') renderRecords();
    if (name === 'settings') { $('#opt-sound').checked = settings.sound; $('#opt-vibrate').checked = settings.vibrate; renderSetup(); }
    window.scrollTo(0, 0);
  }

  /* ---------- events ---------- */
  $$('.stepper').forEach((st) => {
    st.addEventListener('click', (e) => {
      const btn = e.target.closest('.st-btn');
      if (!btn) return;
      const k = st.dataset.key;
      const [lo, hi, step] = LIMITS[k];
      settings[k] = clamp(settings[k] + Number(btn.dataset.dir) * step, lo, hi);
      saveSettings();
      renderSetup();
    });
  });
  $('#btn-reset-default').addEventListener('click', () => { Object.assign(settings, { work: 20, rest: 10, rounds: 8, warmup: 10 }); saveSettings(); renderSetup(); });
  $('#preset-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.preset = b.dataset.preset;
    saveSettings();
    renderSetup();
  });
  $('#custom-text').value = settings.custom;
  $('#custom-text').addEventListener('input', (e) => { settings.custom = e.target.value; saveSettings(); renderSetup(); });
  $('#btn-start').addEventListener('click', startWorkout);
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-stop').addEventListener('click', onStopClick);
  $('#btn-again').addEventListener('click', () => { setPanel('setup'); renderSetup(); });
  $('#btn-to-records').addEventListener('click', () => { setPanel('setup'); renderSetup(); showView('records'); });
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#opt-sound').addEventListener('change', (e) => { settings.sound = e.target.checked; saveSettings(); if (settings.sound) { initAudio(); beep(660, 0.12); } });
  $('#opt-vibrate').addEventListener('change', (e) => { settings.vibrate = e.target.checked; saveSettings(); if (settings.vibrate) vibrate(60); });
  $('#history').addEventListener('click', (e) => {
    const b = e.target.closest('.h-del');
    if (!b) return;
    history = history.filter((h) => String(h.id) !== b.dataset.id);
    saveHistory();
    renderRecords();
  });
  let clearArm = null;
  $('#btn-clear').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (clearArm) { clearTimeout(clearArm); clearArm = null; history = []; saveHistory(); b.textContent = '모든 기록 삭제'; return; }
    b.textContent = '한 번 더 누르면 모든 기록이 삭제됩니다';
    clearArm = setTimeout(() => { clearArm = null; b.textContent = '모든 기록 삭제'; }, 3000);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && run.active && !run.paused) { requestLock(); tick(); } });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && run.active && !/^(TEXTAREA|INPUT|BUTTON)$/.test(document.activeElement.tagName)) { e.preventDefault(); togglePause(); }
  });

  renderSetup();
  setPanel('setup');
})();
