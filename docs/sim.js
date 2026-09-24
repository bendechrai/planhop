// The planning model behind the page's chart. Plain browser script (no modules)
// so the page also works opened from disk; the tests load it the same way.
// Every pick comes from choose.js, copied from planhop's build (pnpm docs).
(() => {
  const { choose, score, FULL } = globalThis.planhopChoose;

  const HOUR = 3_600_000;
  const WEEK = 168;
  const STEPS_PER_HOUR = 6; // 10-minute steps
  const STEP = 1 / STEPS_PER_HOUR;
  const WARMUP = WEEK; // a week of use before the chart starts, so nobody starts fresh
  const MEASURE = 2 * WEEK; // the chart and the stats both cover two weeks
  const MAX_SUBS = 40;
  /** Assumption: a full 5-hour window is this share of a week's quota. Not published by Anthropic. */
  const WINDOW_SHARE = 1 / 8;
  const BASE = Date.UTC(2026, 0, 5);

  /**
   * Slider 0..100 -> % of a 5-hour window per hour, on a log scale from 5% up
   * to 100%: the pace at which running around the clock needs 21 subscriptions.
   */
  const rateOf = (level) => 5 * Math.pow(20, level / 100);

  /**
   * Use Claude Code for `day` hours out of every 24 at `rate`% of a 5-hour
   * window per hour. planhop picks when a session starts and again whenever the
   * current subscription hits a limit (quit, `claude -c`). A warm-up week runs
   * first so every subscription starts wherever steady use would leave it.
   */
  function simulate(resets, rate, day, record) {
    const subs = resets.map((h7, i) => ({ i, u7: 0, r7: h7 - WARMUP, u5: 0, r5: null }));
    const perHour5 = rate / 100;
    const perHour7 = perHour5 * WINDOW_SHARE;
    const runs = [];
    const windows = subs.map(() => []);
    let waiting = 0;
    let wanted = 0;
    let unused = 0;
    let resetsSeen = 0;
    let current = null;

    // Count whole steps so the clock never drifts (floating-point sums would
    // occasionally skip the first step of a day).
    const stepsPerDay = 24 * STEPS_PER_HOUR;
    const stepsInUse = day * STEPS_PER_HOUR;
    for (let k = -WARMUP * STEPS_PER_HOUR; k < MEASURE * STEPS_PER_HOUR; k++) {
      const t = k / STEPS_PER_HOUR;
      const measuring = t >= 0;
      const charting = record && measuring;
      for (const s of subs) {
        if (s.r5 !== null && t >= s.r5 - 1e-9) { s.r5 = null; s.u5 = 0; }
        if (t >= s.r7 - 1e-9) {
          if (measuring) { unused += 1 - s.u7; resetsSeen++; }
          s.u7 = 0;
          s.r7 += WEEK;
        }
      }
      const inUse = ((k % stepsPerDay) + stepsPerDay) % stepsPerDay < stepsInUse;
      if (!inUse) { current = null; continue; }
      if (measuring) wanted += STEP;

      // Spend this step's use; if the subscription in use hits a limit partway
      // through, planhop moves on and the rest of the step goes to the next pick.
      let remaining = 1;
      for (let hops = 0; remaining > 1e-6 && hops <= subs.length; hops++) {
        if (current === null || subs[current].u5 >= FULL || subs[current].u7 >= FULL) {
          const now = BASE + t * HOUR;
          const scored = subs.map((s) => score({
            name: String(s.i), dir: "", u5: s.u5, u7: s.u7, fetchedAt: now, stale: false,
            r5: s.r5 === null ? null : BASE + s.r5 * HOUR, r7: BASE + s.r7 * HOUR,
          }, now));
          const c = choose(scored);
          current = c && !c.blocked ? Number(c.name) : null;
        }
        if (current === null) break;
        const s = subs[current];
        if (s.r5 === null) {
          s.r5 = t + 5;
          if (charting) windows[current].push({ from: t, to: t + 5, used: 0 });
        }
        const frac = Math.min(remaining, (1 - s.u5) / (perHour5 * STEP), (1 - s.u7) / (perHour7 * STEP));
        s.u5 = Math.min(1, s.u5 + perHour5 * STEP * frac);
        s.u7 = Math.min(1, s.u7 + perHour7 * STEP * frac);
        const from = t + STEP * (1 - remaining);
        remaining -= frac;
        if (!charting || frac <= 0) continue;
        const w = windows[current].at(-1);
        if (w) w.used = s.u5;
        const last = runs.at(-1);
        if (last && last.i === current && Math.abs(last.to - from) < 1e-6) last.to = from + STEP * frac;
        else runs.push({ i: current, from, to: from + STEP * frac });
      }
      if (measuring && remaining > 1e-6) waiting += STEP * remaining;
    }
    return { runs, windows, waiting, wanted, unused: resetsSeen ? unused / resetsSeen : 0 };
  }

  /** A week's use at this pace, in weeks of one subscription's quota. */
  const weeklyDemand = (rate, day) => (rate / 100) * WINDOW_SHARE * day * 7;

  /**
   * Fewest subscriptions (resets spread evenly) that never leave you waiting at
   * this pace. Never fewer than the weekly demand, whatever a two-week run says:
   * leftover quota from the warm-up can hide a shortfall for a while.
   */
  function subscriptionsNeeded(rate, day) {
    for (let n = Math.max(1, Math.ceil(weeklyDemand(rate, day) - 1e-6)); n <= MAX_SUBS; n++) {
      const resets = Array.from({ length: n }, (_, i) => Math.round(((i + 1) * WEEK) / n));
      const sim = simulate(resets, rate, day, false);
      if (sim.waiting <= Math.max(0.5, sim.wanted * 0.005)) return n;
    }
    return null;
  }

  /**
   * Share of wanted time covered, never more than n subscriptions can supply:
   * a two-week run can hide a shortfall with quota left over from the warm-up.
   */
  function coverage(sim, n, rate, day) {
    const supplyLimit = Math.min(1, n / weeklyDemand(rate, day));
    return Math.min(sim.wanted ? 1 - sim.waiting / sim.wanted : 1, supplyLimit);
  }

  globalThis.planhopSim = { simulate, subscriptionsNeeded, coverage, weeklyDemand, rateOf, WEEK, MEASURE, MAX_SUBS, WINDOW_SHARE };
})();
