// GTA VI launch-day Twitch viewer forecaster.
//
// Idea: the shape of a big console launch's release day on Twitch is
// remarkably repeatable once you scale it by the first hour. Hour 1's print
// tells you the launch's size; the 37 past launches in the case file tell
// you how a day of that size usually unfolds, hour by hour, and how much
// launches of that size vary around the usual shape.
//
// For each forecast hour h = 2..24 this program fits, across the past
// launches, a weighted local-linear regression of the log ratio
// ln(viewers_h / viewers_1) on ln(viewers_1), with Gaussian kernel weights
// centred on this case's own hour-1 print (bandwidth 1.0 in log units,
// widened to 1.5 if the effective sample size is under 5; an unweighted
// median if it is still under 5). The fitted value is the median log ratio;
// the spread comes from the weighted quantiles of the regression residuals
// at 0.05 / 0.25 / 0.5 / 0.75 / 0.95, so the five quantiles are the
// empirical spread of comparable launches, not a guessed normal spread.
//
// Only the hour-1 print and the comparables' release-day curves are used.
// The case's minute history, top streams and category tables add nothing
// beyond hour 1 once the comparables are in (checked by leave-one-out
// cross-validation on the past launches), so they are deliberately ignored.
//
// Node 22, standard library only, no network, no randomness: the same
// input always produces the same bytes. If anything goes wrong with a case,
// that case falls back to the house persistence baseline instead of
// crashing, so every case still yields a valid forecast.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels, in the order each output row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles, used only by the fallback baseline. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Fallback spread, in log units per square-root hour. */
const FALLBACK_SIGMA = 0.15;
/** Kernel bandwidth (log units) for the local-linear fit, then the widened one. */
const BANDWIDTHS = [1.0, 1.5];
/** Minimum effective sample size for a kernel fit to be trusted. */
const MIN_ESS = 5;
/** Clamp on the fitted median log ratio, keeping forecasts in sane territory. */
const LOG_RATIO_MIN = -2.5;
const LOG_RATIO_MAX = 3.5;
const HOUR_MS = 3600 * 1000;

interface KnownRow {
  hour: number;
  viewers: number;
}

interface HourlyPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  day_start: string;
  hourly: HourlyPoint[];
}

interface CaseFile {
  known: KnownRow[];
  forecast: Array<{ hour: number }>;
  comparables?: Comparable[];
}

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Median of a list of finite numbers (average of the middle two when even). */
const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/**
 * The tau-quantile of values with weights: sort by value, walk the
 * cumulative weight, and take the first value whose cumulative weight
 * reaches tau of the total. Equal weights give the ordinary quantile.
 */
const weightedQuantile = (values: number[], weights: number[], tau: number): number => {
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const total = pairs.reduce((s, p) => s + p.w, 0);
  if (total <= 0 || pairs.length === 0) return pairs.length === 0 ? 0 : pairs[pairs.length - 1].v;
  const threshold = tau * total;
  let cum = 0;
  for (const p of pairs) {
    cum += p.w;
    if (cum >= threshold) return p.v;
  }
  return pairs[pairs.length - 1].v;
};

/**
 * One comparable's release-day curve: viewers for hours 0..23 after its
 * day_start, or null when any of the 24 hours is missing or not positive.
 * A comparable with no release day at all (the GTA VI pre-release entry)
 * drops out here automatically.
 */
const releaseCurve = (comp: Comparable): number[] | null => {
  if (!comp || typeof comp.day_start !== 'string' || !Array.isArray(comp.hourly)) return null;
  const start = Date.parse(comp.day_start);
  if (!Number.isFinite(start)) return null;
  const curve: Array<number | null> = new Array(24).fill(null);
  for (const point of comp.hourly) {
    if (!point || typeof point.from !== 'string') continue;
    const t = Date.parse(point.from);
    const v = point.viewers;
    if (!Number.isFinite(t) || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    const idx = Math.round((t - start) / HOUR_MS);
    if (idx >= 0 && idx < 24 && curve[idx] === null) curve[idx] = v;
  }
  if (curve.some((v) => v === null)) return null;
  return curve as number[];
};

/** The house persistence baseline for one hour: every quantile around p1. */
const baselineQuantiles = (p1: number, h: number): number[] =>
  Z.map((z) => round2(clamp(p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(h - 1)), 1, 1e9)));

/**
 * Forecast quantiles for one hour from the kept comparables.
 * `idx` is the curve index of the hour (hour - 1, so hour 2 is index 1).
 * Falls back to the baseline when there is nothing usable to fit on.
 */
const forecastHour = (p1: number, h: number, curves: number[][], idx: number): number[] => {
  if (curves.length === 0) return baselineQuantiles(p1, h);
  const x0 = Math.log(p1);
  const xs = curves.map((c) => Math.log(c[0]));
  const ys = curves.map((c) => Math.log(c[idx] / c[0]));

  // Weighted local-linear fit at x0, widening the kernel if the effective
  // sample size is too small; an unweighted median if it stays too small.
  // The first bandwidth whose ESS reaches MIN_ESS wins, so a well-covered
  // size (ESS >= 5 at bw 1.0) keeps the tighter, more local fit.
  let weights: number[] | null = null;
  let a = 0;
  let b = 0;
  for (const bw of BANDWIDTHS) {
    const w = xs.map((x) => Math.exp(-0.5 * ((x - x0) / bw) ** 2));
    const sw = w.reduce((s, v) => s + v, 0);
    const sw2 = w.reduce((s, v) => s + v * v, 0);
    const ess = sw2 > 0 ? (sw * sw) / sw2 : 0;
    if (ess < MIN_ESS) continue;
    weights = w;
    const swx = w.reduce((s, v, i) => s + v * xs[i], 0);
    const swy = w.reduce((s, v, i) => s + v * ys[i], 0);
    const swxx = w.reduce((s, v, i) => s + v * xs[i] * xs[i], 0);
    const swxy = w.reduce((s, v, i) => s + v * xs[i] * ys[i], 0);
    const denom = sw * swxx - swx * swx;
    if (Math.abs(denom) < 1e-12) {
      a = swy / sw;
      b = 0;
    } else {
      b = (sw * swxy - swx * swy) / denom;
      a = (swy - b * swx) / sw;
    }
    break;
  }
  if (weights === null) {
    // Too few effective neighbours even with the wide kernel: the median
    // log ratio across all comparables, with an equal-weight spread.
    weights = xs.map(() => 1);
    a = median(ys);
    b = 0;
  }

  const yhat = clamp(a + b * x0, LOG_RATIO_MIN, LOG_RATIO_MAX);
  const residuals = ys.map((y, i) => y - (a + b * xs[i]));
  const qs = LEVELS.map((tau) => {
    const q = p1 * Math.exp(yhat + weightedQuantile(residuals, weights as number[], tau));
    return clamp(q, 1, 1e9);
  });
  // Round to 2 decimals and keep the five quantiles non-decreasing.
  const out: number[] = [];
  let prev = 0;
  for (const q of qs) {
    const r = Math.max(round2(q), prev);
    out.push(r);
    prev = r;
  }
  return out;
};

/** Forecast one case: 23 rows, hours 2..24, or the baseline if it fails. */
const forecastCase = (c: CaseFile): { hours: Array<{ hour: number; q: number[] }> } => {
  const first = (c.known ?? []).find((k) => k.hour === 1);
  if (!first || typeof first.viewers !== 'number' || !Number.isFinite(first.viewers)) {
    throw new Error('case has no usable hour-1 print');
  }
  const p1 = Math.max(1, first.viewers);
  const hoursToForecast = (c.forecast ?? []).map((f) => f.hour).filter((h) => h >= 2 && h <= 24);
  const wanted = hoursToForecast.length === 23 ? hoursToForecast : Array.from({ length: 23 }, (_, i) => i + 2);
  const curves: number[][] = [];
  for (const comp of c.comparables ?? []) {
    const curve = releaseCurve(comp);
    if (curve !== null) curves.push(curve);
  }
  const hours = wanted.map((h) => ({ hour: h, q: forecastHour(p1, h, curves, h - 1) }));
  return { hours };
};

/** Baseline-only forecast for a case whose hour-1 print we could still read. */
const baselineCase = (c: CaseFile): { hours: Array<{ hour: number; q: number[] }> } => {
  const first = (c.known ?? []).find((k) => k.hour === 1);
  const p1 = first && Number.isFinite(first.viewers) ? Math.max(1, first.viewers) : 1;
  const hours = Array.from({ length: 23 }, (_, i) => i + 2).map((h) => ({ hour: h, q: baselineQuantiles(p1, h) }));
  return { hours };
};

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  let result: { hours: Array<{ hour: number; q: number[] }> };
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
    result = forecastCase(c);
  } catch {
    // Never crash and never leave a case without an output: fall back to
    // the persistence baseline built from whatever hour-1 print we can read.
    try {
      const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
      result = baselineCase(c);
    } catch {
      result = baselineCase({ known: [{ hour: 1, viewers: 1 }], forecast: [] });
    }
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(result)}\n`);
}
