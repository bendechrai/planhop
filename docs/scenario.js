// Planning tool: simulate how planhop spreads use across any number of
// subscriptions. Every pick comes from choose.js, copied from planhop's build
// (pnpm docs), so the page and the tool always agree.
// Classic scripts rather than modules so the page also works opened from disk.
(() => {
  const { simulate, subscriptionsNeeded, coverage, rateOf, WEEK, MEASURE, MAX_SUBS } = globalThis.planhopSim;
  const STEVE = 21;

  const COLORS = ["#2f6fdb", "#8e3b8f", "#1f8a70", "#c0641a", "#6b5bd6", "#b23a48", "#3f7d20", "#a07400", "#0f7ea8", "#9c4f96"];


  const svg = document.getElementById("plan-svg");
  const caption = document.getElementById("plan-caption");
  const zones = document.getElementById("chart-zones");
  const wrap = svg.parentElement;
  const rateInput = document.getElementById("in-rate");
  const dayInput = document.getElementById("in-day");
  const steve = document.getElementById("steve");
  const NS = "http://www.w3.org/2000/svg";

  const DEFAULTS = { level: 21, day: 24, resets: [124, 45] };
  const state = { level: DEFAULTS.level, day: DEFAULTS.day, subs: [] };
  let drag = null;
  let needTimer = null;
  let needed; // undefined while being worked out, null for "more than MAX_SUBS"
  let steveDismissed = false;

  let nextColor = 0;
  const color = () => COLORS[nextColor++ % COLORS.length];
  const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
  function resetSubs(resets) {
    nextColor = 0;
    state.subs = resets.map((h7) => ({ color: color(), h7 }));
  }

  /** Put a new subscription's reset in the middle of the biggest gap between existing ones. */
  function nextReset() {
    const hs = state.subs.map((s) => s.h7).sort((a, b) => a - b);
    if (hs.length === 0) return 84;
    let best = [hs[hs.length - 1] - WEEK, hs[0]];
    for (let i = 0; i + 1 < hs.length; i++) {
      if (hs[i + 1] - hs[i] > best[1] - best[0]) best = [hs[i], hs[i + 1]];
    }
    const h = ((Math.round((best[0] + best[1]) / 2) % WEEK) + WEEK) % WEEK;
    return h === 0 ? WEEK : h;
  }

  function fmt(hours) {
    const mins = Math.round(hours * 60);
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d) return h ? `${d}d ${h}h` : `${d}d`;
    if (h) return m ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  }

  function levelWord(rate) {
    if (rate < 14) return "Light";
    if (rate < 22) return "Steady";
    if (rate < 40) return "Busy";
    if (rate < 80) return "Heavy";
    return "Software factory";
  }

  function summary(sim) {
    const n = state.subs.length;
    const covered = coverage(sim, n, rateOf(state.level), state.day);
    const waiting = covered < 0.995;
    const parts = [];
    if (covered >= 0.995) parts.push(`${n} ${n === 1 ? "subscription covers" : "subscriptions cover"} you all the time at this pace.`);
    else parts.push(`With ${n} ${n === 1 ? "subscription" : "subscriptions"}, you'd be waiting on a limit ${Math.max(1, Math.round((1 - covered) * 100))}% of the time you want to use Claude Code.`);
    const unused = Math.round(sim.unused * 100);
    parts.push(unused <= 0 ? "No quota expires unused." : `About ${unused}% of each week's quota expires unused.`);
    // `needed` is undefined while it's being worked out: say nothing rather than flash a placeholder
    if (needed === undefined) return parts.join(" ");
    if (needed === null) parts.push(`You'd need more than ${MAX_SUBS} subscriptions never to wait.`);
    else if (needed > n) parts.push(`You'd need ${needed} subscriptions never to wait.`);
    else if (waiting) parts.push("Spreading their weekly resets out more evenly would stop the waiting.");
    else if (needed < n) parts.push(`${needed} would be enough.`);
    return parts.join(" ");
  }

  function el(name, attrs = {}, text) {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    return n;
  }

  let lastSim = null;

  function render() {
    const rate = rateOf(state.level);
    const sim = simulate(state.subs.map((s) => s.h7), rate, state.day, true);
    lastSim = sim;
    const n = state.subs.length;
    const W = Math.max(300, svg.parentElement.clientWidth);
    const narrow = W < 560;
    const laneH = n <= 3 ? 40 : n <= 8 ? 26 : 14;
    const gap = n <= 3 ? 30 : n <= 8 ? 24 : 20;
    const top = 4;
    const lanesEnd = top + n * (gap + laneH);
    const H = lanesEnd + 40;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("height", H);
    const focusedId = document.activeElement?.closest?.(".handle")?.id;
    svg.replaceChildren();

    const x0 = 16;
    const x1 = W - 16;
    const x = (h) => x0 + ((x1 - x0) * Math.min(Math.max(h, 0), MEASURE)) / MEASURE;
    const barY = (i) => top + i * (gap + laneH) + gap;

    if (state.day < 24) {
      for (let d = 0; d < MEASURE / 24; d++) {
        svg.append(el("rect", { class: "workday", x: x(d * 24), y: top + gap - 4, width: x(d * 24 + state.day) - x(d * 24), height: lanesEnd - top - gap + 8 }));
      }
    }

    svg.append(el("line", { class: "axis", x1: x0, y1: lanesEnd + 10, x2: x1, y2: lanesEnd + 10 }));
    const ticks = el("g", { class: "tick" });
    const lastDay = MEASURE / 24;
    for (let day = 0; day <= lastDay; day += narrow ? 7 : W < 800 ? 2 : 1) {
      ticks.append(el("text", { x: x(day * 24), y: lanesEnd + 30, "text-anchor": day === 0 ? "start" : day === lastDay ? "end" : "middle" }, day === 0 ? "now" : `+${day}d`));
    }
    svg.append(ticks);

    const labels = [];
    state.subs.forEach((s, i) => {
      const y = barY(i);
      const label = el("text", { class: n > 8 ? "lane-label tiny" : "lane-label", x: x0 + 6, y: y - 6, fill: s.color }, `Subscription ${i + 1}`);
      label.append(el("tspan", { class: "lane-note", dx: 8 }, `resets in ${fmt(s.h7)}`));
      labels.push(label);
      svg.append(el("rect", { x: x0, y, width: x1 - x0, height: laneH, rx: 3, fill: s.color, opacity: 0.1 }));
      for (const w of sim.windows[i]) {
        const wx = x(w.from);
        const ww = Math.max(2, x(w.to) - wx);
        svg.append(el("rect", { x: wx, y: y + 2, width: ww, height: laneH - 4, rx: 2, fill: s.color, opacity: 0.18 }));
        const uh = (laneH - 4) * w.used;
        svg.append(el("rect", { x: wx, y: y + laneH - 2 - uh, width: ww, height: uh, rx: 2, fill: s.color, opacity: 0.5 }));
      }
    });
    svg.append(el("line", { class: "now", x1: x0, y1: top + gap - 6, x2: x0, y2: lanesEnd + 10 }));

    // Time in use: a dark bar on whichever subscription is in use, a thin link at each switch
    let prev = null;
    for (const r of sim.runs) {
      const y = barY(r.i) + laneH / 2;
      if (prev && prev.i !== r.i && Math.abs(prev.to - r.from) < 0.01) {
        svg.append(el("line", { class: "link", x1: x(r.from), y1: barY(prev.i) + laneH / 2, x2: x(r.from), y2: y }));
      }
      svg.append(el("line", { class: "run", x1: x(r.from), y1: y, x2: Math.max(x(r.to), x(r.from) + 1.5), y2: y }));
      prev = r;
    }

    // Each week's reset repeats a week later; only the first marker is draggable
    state.subs.forEach((s, i) => {
      const y = barY(i);
      const hx = x(s.h7 + WEEK);
      if (s.h7 + WEEK < MEASURE) svg.append(el("line", { x1: hx, y1: y - 1, x2: hx, y2: y + laneH + 1, stroke: s.color, "stroke-width": 2, "stroke-dasharray": "3 3", opacity: 0.7 }));
    });

    // Labels go over the switch lines, with a halo so they stay readable
    svg.append(...labels);

    state.subs.forEach((s, i) => {
      const y = barY(i);
      const hx = x(s.h7);
      const g = el("g", {
        id: `h7-${i}`, class: "handle", tabindex: 0, role: "slider",
        "aria-label": `Subscription ${i + 1} weekly reset`, "aria-valuemin": 1, "aria-valuemax": 168,
        "aria-valuenow": s.h7, "aria-valuetext": `resets in ${fmt(s.h7)}`,
      });
      g.dataset.index = String(i);
      g.append(
        el("rect", { class: "hit", x: hx - 12, y: y - 4, width: 24, height: laneH + 8 }),
        el("line", { x1: hx, y1: y - 3, x2: hx, y2: y + laneH + 3, stroke: s.color, "stroke-width": 2.5 }),
        el("circle", { class: "knob", cx: hx, cy: y + laneH / 2, r: laneH < 20 ? 5 : 6.5, stroke: s.color }),
      );
      svg.append(g);
    });

    renderZones({ barY, laneH, gap, n });
    caption.textContent = summary(sim);
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
    renderControls(rate);
    renderSteve();
  }

  function renderControls(rate) {
    document.getElementById("out-rate").textContent = rate <= 20
      ? `${levelWord(rate)}: a 5-hour window never fills`
      : `${levelWord(rate)}: a 5-hour window fills in about ${fmt(100 / rate)}`;
    document.getElementById("out-day").textContent = state.day === 24 ? "Around the clock" : `${state.day}h a day`;
    if (Number(rateInput.value) !== state.level) rateInput.value = String(state.level);
    if (Number(dayInput.value) !== state.day) dayInput.value = String(state.day);

  }

  /**
   * Hover overlays: (+) across subscriptions 1 and 2 adds one; (-) on any
   * later subscription removes it. The buttons stay in the tab order and show
   * their overlay when focused, for keyboard and touch.
   */
  function renderZones({ barY, laneH, gap, n }) {
    const focused = document.activeElement?.closest?.(".zone")?.dataset.zone;
    zones.replaceChildren();
    const make = (key, top, bottom, label, icon, disabled) => {
      const z = document.createElement("div");
      z.className = "zone";
      z.dataset.zone = key;
      z.style.top = `${top}px`;
      z.style.height = `${bottom - top}px`;
      // full size on the (+) overlay; (-) buttons shrink to fit thinner rows
      z.style.setProperty("--btn", `${Math.min(42, Math.max(18, bottom - top - 10))}px`);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "zone-btn";
      b.setAttribute("aria-label", label);
      b.innerHTML = icon;
      b.disabled = disabled;
      z.append(b);
      zones.append(z);
      return z;
    };
    const top0 = barY(0) - gap + 2;
    make("add", top0, barY(Math.min(1, n - 1)) + laneH + 2, "Add a subscription", ICON_PLUS, n >= MAX_SUBS);
    for (let i = 2; i < n; i++) make(String(i), barY(i) - gap + 2, barY(i) + laneH + 2, `Remove subscription ${i + 1}`, ICON_MINUS, false);
    if (hovered) zones.querySelector(`[data-zone="${hovered}"]`)?.classList.add("on");
    if (focused) zones.querySelector(`[data-zone="${focused}"] button`)?.focus({ preventScroll: true });
  }

  let hovered = null;
  let justShown = false;
  /** Which overlay (if any) is under the pointer. None while over a reset marker, so it stays draggable. */
  function hoverAt(clientX, clientY) {
    const y = clientY - wrap.getBoundingClientRect().top;
    const onHandle = document.elementsFromPoint(clientX, clientY).some((n) => n.closest?.(".handle"));
    let key = null;
    for (const z of zones.children) {
      const top = parseFloat(z.style.top);
      if (y >= top && y <= top + parseFloat(z.style.height)) key = z.dataset.zone;
    }
    const next = drag === null && !onHandle ? key : null;
    if (next === hovered) return false;
    hovered = next;
    for (const z of zones.children) z.classList.toggle("on", z.dataset.zone === hovered);
    return true;
  }
  wrap.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") hoverAt(e.clientX, e.clientY); });
  wrap.addEventListener("pointerdown", (e) => {
    // On touch, the first tap on a row shows its overlay; a second tap acts on it.
    if (e.pointerType !== "mouse" && !e.target.closest(".handle")) justShown = hoverAt(e.clientX, e.clientY);
  });
  wrap.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    hovered = null;
    for (const z of zones.children) z.classList.remove("on");
  });
  zones.addEventListener("click", (e) => {
    const z = e.target.closest(".zone");
    if (!z || justShown) { justShown = false; return; }
    const b = z.querySelector(".zone-btn");
    if (!b || b.disabled) return;
    const key = z.dataset.zone;
    if (key === "add") state.subs.push({ color: color(), h7: nextReset() });
    else state.subs.splice(Number(key), 1);
    hovered = key === "add" ? "add" : null;
    update();
  });

  /** Easter egg: a wave for anyone running 21 subscriptions. */
  function renderSteve() {
    if (!steve) return;
    const show = state.subs.length === STEVE && !steveDismissed;
    if (state.subs.length !== STEVE) steveDismissed = false;
    steve.hidden = !show;
  }

  /** Re-run the slower "how many would you need" search once input settles. */
  function update() {
    needed = undefined;
    render();
    clearTimeout(needTimer);
    needTimer = setTimeout(() => {
      needed = subscriptionsNeeded(rateOf(state.level), state.day);
      if (lastSim) caption.textContent = summary(lastSim);
    }, 250);
  }

  function setReset(i, value) {
    const v = Math.min(WEEK, Math.max(1, Math.round(value)));
    if (state.subs[i].h7 === v) return;
    state.subs[i].h7 = v;
    render();
  }

  function valueAt(clientX) {
    const box = svg.getBoundingClientRect();
    return ((clientX - box.left - 16) / (box.width - 32)) * MEASURE;
  }

  svg.addEventListener("pointerdown", (e) => {
    const h = e.target.closest(".handle");
    if (!h) return;
    e.preventDefault();
    drag = Number(h.dataset.index);
    svg.setPointerCapture(e.pointerId);
    h.focus({ preventScroll: true });
  });
  svg.addEventListener("pointermove", (e) => { if (drag !== null) setReset(drag, valueAt(e.clientX)); });
  const endDrag = () => { drag = null; };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("keydown", (e) => {
    const h = e.target.closest(".handle");
    if (!h) return;
    const i = Number(h.dataset.index);
    const unit = e.shiftKey ? 12 : 1;
    const delta = { ArrowRight: unit, ArrowUp: unit, ArrowLeft: -unit, ArrowDown: -unit }[e.key];
    if (e.key === "Home") setReset(i, 1);
    else if (e.key === "End") setReset(i, WEEK);
    else if (delta !== undefined) setReset(i, state.subs[i].h7 + delta);
    else return;
    e.preventDefault();
  });

  rateInput.addEventListener("input", () => { state.level = Number(rateInput.value); update(); });
  dayInput.addEventListener("input", () => { state.day = Number(dayInput.value); update(); });
  // Intro tip: shown until dismissed or until the chart is first used
  const tip = document.getElementById("chart-tip");
  const TIP_KEY = "planhop-tip-dismissed";
  let tipGone = false;
  try { tipGone = localStorage.getItem(TIP_KEY) === "1"; } catch { /* storage unavailable */ }
  function dismissTip() {
    if (!tip || tip.hidden) return;
    tip.hidden = true;
    tipGone = true;
    try { localStorage.setItem(TIP_KEY, "1"); } catch { /* storage unavailable */ }
  }
  if (tip && !tipGone) tip.hidden = false;
  document.getElementById("chart-tip-close")?.addEventListener("click", dismissTip);
  zones.addEventListener("click", dismissTip);
  svg.addEventListener("pointerdown", (e) => { if (e.target.closest(".handle")) dismissTip(); });
  svg.addEventListener("keydown", (e) => { if (e.target.closest(".handle")) dismissTip(); });

  document.getElementById("steve-close")?.addEventListener("click", () => {
    steveDismissed = true;
    renderSteve();
    zones.querySelector('[data-zone="add"] button')?.focus();
  });

  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = svg.parentElement.clientWidth;
    if (w !== lastWidth && drag === null) { lastWidth = w; render(); }
  }).observe(svg.parentElement);

  resetSubs(DEFAULTS.resets);
  update();
})();
