/**
 * 1-D Gaussian Hidden Markov Model.
 *
 *   - fitBaumWelch(observations, K, opts) → HmmParams
 *       offline EM. Used periodically (monthly) to refit on a rolling window.
 *
 *   - filteredPosterior(params, history) → number[]
 *       online forward algorithm. Returns P(r_t | y_{1:t}) over K states.
 *       Suitable for real-time decisions; uses NO future data.
 *
 *   - viterbi(params, observations) → number[]
 *       offline MAP state path. Used for diagnostics + W-matrix labeling.
 *
 * All routines work in log-space to avoid underflow on long sequences.
 */
import type { HmmParams, RegimeId } from "./types";
import { REGIMES } from "./types";

const LOG_2PI = Math.log(2 * Math.PI);
const MIN_STD = 1e-8;
const MIN_PROB = 1e-300;

function logGaussian(x: number, mean: number, std: number): number {
  const sigma = Math.max(std, MIN_STD);
  const z = (x - mean) / sigma;
  return -0.5 * (z * z + LOG_2PI) - Math.log(sigma);
}

function logSumExp(values: number[]): number {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  if (!Number.isFinite(max)) return max;
  let sum = 0;
  for (const v of values) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

function normalizeRow(row: number[]): number[] {
  const sum = row.reduce((s, x) => s + x, 0);
  if (sum <= 0) return row.map(() => 1 / row.length);
  return row.map((x) => x / sum);
}

/** Sort states ascending by mean and apply labels low→high: bear, range, bull. */
function relabelByMean(params: HmmParams): HmmParams {
  const K = params.means.length;
  const order = Array.from({ length: K }, (_, i) => i).sort(
    (a, b) => params.means[a] - params.means[b],
  );
  const labels: RegimeId[] = [];
  if (K === 3) {
    labels.push("bear", "range", "bull");
  } else {
    for (let i = 0; i < K; i++) labels.push((REGIMES[i] ?? "range") as RegimeId);
  }
  const initial = order.map((i) => params.initial[i]);
  const means = order.map((i) => params.means[i]);
  const stds = order.map((i) => params.stds[i]);
  const transition: number[][] = order.map((from) => order.map((to) => params.transition[from][to]));
  return { initial, transition, means, stds, labels };
}

export interface BaumWelchOptions {
  maxIter?: number;
  tol?: number;
  /** Minimum standard deviation (avoid degenerate states). */
  minStd?: number;
  /** Random seed for reproducibility (linear-congruential generator). */
  seed?: number;
  /** Initial parameters. If omitted, k-means-style initialization is used. */
  init?: HmmParams;
}

export function fitBaumWelch(
  observations: readonly number[],
  K: number,
  opts: BaumWelchOptions = {},
): HmmParams {
  const T = observations.length;
  if (T < K * 10) throw new Error(`Need at least ${K * 10} observations to fit a ${K}-state HMM`);
  const maxIter = opts.maxIter ?? 100;
  const tol = opts.tol ?? 1e-5;
  const minStd = opts.minStd ?? 1e-6;

  let params = opts.init ?? initializeParams(observations, K, opts.seed ?? 42);
  let prevLogLik = -Infinity;

  for (let iter = 0; iter < maxIter; iter++) {
    const { logAlpha, logLik } = forwardLog(observations, params);
    const logBeta = backwardLog(observations, params);

    // E-step: γ_t(i) = α_t(i)·β_t(i) / P(O), ξ_t(i,j) ∝ α_t(i)·a_ij·b_j(o_{t+1})·β_{t+1}(j)
    const logGamma: number[][] = new Array(T);
    for (let t = 0; t < T; t++) {
      const row = new Array<number>(K);
      let sum = -Infinity;
      for (let i = 0; i < K; i++) {
        row[i] = logAlpha[t][i] + logBeta[t][i];
        sum = i === 0 ? row[i] : logSumExp([sum, row[i]]);
      }
      for (let i = 0; i < K; i++) row[i] -= sum;
      logGamma[t] = row;
    }

    const sumXi: number[][] = Array.from({ length: K }, () => new Array(K).fill(-Infinity));
    for (let t = 0; t < T - 1; t++) {
      const denom: number[] = [];
      const cell: number[][] = Array.from({ length: K }, () => new Array(K).fill(0));
      for (let i = 0; i < K; i++) {
        for (let j = 0; j < K; j++) {
          cell[i][j] =
            logAlpha[t][i] +
            Math.log(Math.max(params.transition[i][j], MIN_PROB)) +
            logGaussian(observations[t + 1], params.means[j], params.stds[j]) +
            logBeta[t + 1][j];
          denom.push(cell[i][j]);
        }
      }
      const z = logSumExp(denom);
      for (let i = 0; i < K; i++) {
        for (let j = 0; j < K; j++) {
          const v = cell[i][j] - z;
          sumXi[i][j] = sumXi[i][j] === -Infinity ? v : logSumExp([sumXi[i][j], v]);
        }
      }
    }

    // M-step
    const newInitial = logGamma[0].map((lg) => Math.exp(lg));
    const newTransition: number[][] = new Array(K);
    for (let i = 0; i < K; i++) {
      const row = new Array<number>(K);
      const denomVals: number[] = [];
      for (let t = 0; t < T - 1; t++) denomVals.push(logGamma[t][i]);
      const denom = logSumExp(denomVals);
      for (let j = 0; j < K; j++) row[j] = Math.exp(sumXi[i][j] - denom);
      newTransition[i] = normalizeRow(row);
    }
    const newMeans = new Array<number>(K);
    const newStds = new Array<number>(K);
    for (let j = 0; j < K; j++) {
      const wList: number[] = [];
      for (let t = 0; t < T; t++) wList.push(logGamma[t][j]);
      const wSum = logSumExp(wList);
      let muNum = 0;
      for (let t = 0; t < T; t++) muNum += Math.exp(logGamma[t][j] - wSum) * observations[t];
      newMeans[j] = muNum;
      let varNum = 0;
      for (let t = 0; t < T; t++) {
        const dx = observations[t] - newMeans[j];
        varNum += Math.exp(logGamma[t][j] - wSum) * dx * dx;
      }
      newStds[j] = Math.max(Math.sqrt(varNum), minStd);
    }

    params = {
      initial: normalizeRow(newInitial),
      transition: newTransition,
      means: newMeans,
      stds: newStds,
      labels: params.labels,
    };

    if (Math.abs(logLik - prevLogLik) < tol) break;
    prevLogLik = logLik;
  }

  return relabelByMean(params);
}

/** Forward algorithm in log space. Returns log α and total log-likelihood. */
function forwardLog(observations: readonly number[], params: HmmParams) {
  const T = observations.length;
  const K = params.means.length;
  const logAlpha: number[][] = new Array(T);
  const logTransition = params.transition.map((row) =>
    row.map((p) => Math.log(Math.max(p, MIN_PROB))),
  );
  const logInit = params.initial.map((p) => Math.log(Math.max(p, MIN_PROB)));

  logAlpha[0] = new Array(K);
  for (let i = 0; i < K; i++) {
    logAlpha[0][i] = logInit[i] + logGaussian(observations[0], params.means[i], params.stds[i]);
  }
  for (let t = 1; t < T; t++) {
    logAlpha[t] = new Array(K);
    for (let j = 0; j < K; j++) {
      const terms = new Array<number>(K);
      for (let i = 0; i < K; i++) terms[i] = logAlpha[t - 1][i] + logTransition[i][j];
      logAlpha[t][j] =
        logSumExp(terms) + logGaussian(observations[t], params.means[j], params.stds[j]);
    }
  }
  const logLik = logSumExp(logAlpha[T - 1]);
  return { logAlpha, logLik };
}

function backwardLog(observations: readonly number[], params: HmmParams) {
  const T = observations.length;
  const K = params.means.length;
  const logBeta: number[][] = new Array(T);
  const logTransition = params.transition.map((row) =>
    row.map((p) => Math.log(Math.max(p, MIN_PROB))),
  );
  logBeta[T - 1] = new Array(K).fill(0);
  for (let t = T - 2; t >= 0; t--) {
    logBeta[t] = new Array(K);
    for (let i = 0; i < K; i++) {
      const terms = new Array<number>(K);
      for (let j = 0; j < K; j++) {
        terms[j] =
          logTransition[i][j] +
          logGaussian(observations[t + 1], params.means[j], params.stds[j]) +
          logBeta[t + 1][j];
      }
      logBeta[t][i] = logSumExp(terms);
    }
  }
  return logBeta;
}

/**
 * Online filtered posterior. Given current params + the most recent
 * observation history, returns P(r_t | y_{1:t}). For incremental updates
 * the worker can call this with growing window — O(K²·T) per call.
 *
 * For sub-second tick rates the worker should keep the running α vector
 * in memory (see `IncrementalHmmFilter`) instead of recomputing.
 */
export function filteredPosterior(
  params: HmmParams,
  observations: readonly number[],
): number[] {
  const { logAlpha } = forwardLog(observations, params);
  const last = logAlpha[logAlpha.length - 1];
  const z = logSumExp(last);
  return last.map((lp) => Math.exp(lp - z));
}

/**
 * Stateful incremental version of the forward algorithm.
 * O(K²) per `step()`. Maintains the running log-α vector across calls.
 */
export class IncrementalHmmFilter {
  private logAlpha: number[];
  private readonly K: number;
  private readonly logTransition: number[][];

  constructor(private readonly params: HmmParams) {
    this.K = params.means.length;
    this.logAlpha = params.initial.map((p) => Math.log(Math.max(p, MIN_PROB)));
    this.logTransition = params.transition.map((row) =>
      row.map((p) => Math.log(Math.max(p, MIN_PROB))),
    );
  }

  /** Push a new observation; returns filtered posterior. */
  step(observation: number): number[] {
    const { K } = this;
    const next = new Array<number>(K);
    for (let j = 0; j < K; j++) {
      const terms = new Array<number>(K);
      for (let i = 0; i < K; i++) terms[i] = this.logAlpha[i] + this.logTransition[i][j];
      next[j] =
        logSumExp(terms) +
        logGaussian(observation, this.params.means[j], this.params.stds[j]);
    }
    this.logAlpha = next;
    const z = logSumExp(next);
    return next.map((lp) => Math.exp(lp - z));
  }

  reset(): void {
    this.logAlpha = this.params.initial.map((p) => Math.log(Math.max(p, MIN_PROB)));
  }
}

/** Viterbi most-likely state path. Offline use only. */
export function viterbi(
  params: HmmParams,
  observations: readonly number[],
): number[] {
  const T = observations.length;
  const K = params.means.length;
  if (T === 0) return [];
  const logTransition = params.transition.map((row) =>
    row.map((p) => Math.log(Math.max(p, MIN_PROB))),
  );
  const delta: number[][] = new Array(T);
  const psi: number[][] = new Array(T);
  delta[0] = new Array(K);
  psi[0] = new Array(K).fill(0);
  for (let i = 0; i < K; i++) {
    delta[0][i] =
      Math.log(Math.max(params.initial[i], MIN_PROB)) +
      logGaussian(observations[0], params.means[i], params.stds[i]);
  }
  for (let t = 1; t < T; t++) {
    delta[t] = new Array(K);
    psi[t] = new Array(K);
    for (let j = 0; j < K; j++) {
      let bestScore = -Infinity;
      let bestArg = 0;
      for (let i = 0; i < K; i++) {
        const score = delta[t - 1][i] + logTransition[i][j];
        if (score > bestScore) {
          bestScore = score;
          bestArg = i;
        }
      }
      delta[t][j] =
        bestScore + logGaussian(observations[t], params.means[j], params.stds[j]);
      psi[t][j] = bestArg;
    }
  }
  const path = new Array<number>(T);
  let bestEnd = 0;
  for (let i = 1; i < K; i++) if (delta[T - 1][i] > delta[T - 1][bestEnd]) bestEnd = i;
  path[T - 1] = bestEnd;
  for (let t = T - 2; t >= 0; t--) path[t] = psi[t + 1][path[t + 1]];
  return path;
}

/**
 * k-means-like initialization: split observations into K equal-sized
 * sorted bins and seed means/stds from each bin.
 */
function initializeParams(observations: readonly number[], K: number, seed: number): HmmParams {
  const sorted = [...observations].sort((a, b) => a - b);
  const T = sorted.length;
  const means = new Array<number>(K);
  const stds = new Array<number>(K);
  for (let k = 0; k < K; k++) {
    const lo = Math.floor((T * k) / K);
    const hi = Math.floor((T * (k + 1)) / K);
    const slice = sorted.slice(lo, Math.max(hi, lo + 1));
    const mean = slice.reduce((s, x) => s + x, 0) / slice.length;
    const variance = slice.reduce((s, x) => s + (x - mean) ** 2, 0) / slice.length;
    means[k] = mean;
    stds[k] = Math.max(Math.sqrt(variance), 1e-6);
  }
  // Slightly perturb means so EM doesn't immediately fall into a tied minimum.
  // LCG for determinism.
  let s = seed >>> 0;
  for (let k = 0; k < K; k++) {
    s = (1664525 * s + 1013904223) >>> 0;
    const u = (s / 0x100000000 - 0.5) * stds[k] * 0.05;
    means[k] += u;
  }
  const initial = new Array<number>(K).fill(1 / K);
  const transition = Array.from({ length: K }, (_, i) =>
    Array.from({ length: K }, (_, j) => (i === j ? 0.95 : 0.05 / (K - 1))),
  );
  const labels: RegimeId[] =
    K === 3 ? ["bear", "range", "bull"] : Array<RegimeId>(K).fill("range");
  return { initial, transition, means, stds, labels };
}
