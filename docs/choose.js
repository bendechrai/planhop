// Generated from src/choose.ts by `pnpm docs`. Do not edit.
(() => {
const TIE_HOURS = 6;
/** Treat an account as at its limit from this fraction used. */
const FULL = 0.995;
const HOUR = 3_600_000;
function score(u, now) {
    // A window whose reset has passed (common for cached readings) has restarted empty.
    const five = u.r5 !== null && u.r5 > now;
    const week = u.r7 !== null && u.r7 > now;
    const u5 = five ? u.u5 : 0;
    const u7 = week ? u.u7 : 0;
    const h5 = five && u.r5 !== null ? (u.r5 - now) / HOUR : null;
    const h7 = week && u.r7 !== null ? (u.r7 - now) / HOUR : null;
    const p5 = h5 === null ? 0 : (1 - u5) * (1 - Math.min(h5, 5) / 5);
    const full5 = u5 >= FULL;
    const full7 = u7 >= FULL;
    const unblockIn = Math.max(full5 ? (h5 ?? 0) : 0, full7 ? (h7 ?? 0) : 0);
    return {
        ...u,
        u5,
        u7,
        r5: five ? u.r5 : null,
        r7: week ? u.r7 : null,
        h5,
        h7,
        p5,
        blocked: full5 || full7,
        unblockIn,
    };
}
const deadline = (a) => a.h7 ?? Number.POSITIVE_INFINITY;
/**
 * Earliest deadline first: only one account is in use at a time, so spend the
 * quota that expires soonest. Accounts at 100% of either limit are skipped
 * (unless all are, then the one that frees up soonest). Weekly resets within
 * TIE_HOURS of the soonest count as a tie, broken by 5h quota about to expire.
 */
function choose(accounts) {
    const usable = accounts.filter((a) => !a.blocked);
    if (usable.length === 0) {
        return [...accounts].sort((a, b) => a.unblockIn - b.unblockIn)[0];
    }
    const soonest = Math.min(...usable.map(deadline));
    const close = usable.filter((a) => deadline(a) <= soonest + TIE_HOURS);
    return [...close].sort((a, b) => b.p5 - a.p5 || deadline(a) - deadline(b))[0];
}
function fmtHours(h) {
    if (h === null)
        return "idle";
    if (h >= 24)
        return `${Math.floor(h / 24)}d${String(Math.floor(h % 24)).padStart(2, "0")}h`;
    return `${Math.floor(h)}h${String(Math.floor((h * 60) % 60)).padStart(2, "0")}m`;
}
function pct(x) {
    return `${Math.round(x * 100)}%`;
}

globalThis.planhopChoose = { TIE_HOURS, FULL, score, choose, fmtHours, pct };
})();
