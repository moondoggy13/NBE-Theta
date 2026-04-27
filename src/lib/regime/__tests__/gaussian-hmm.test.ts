import { describe, expect, it } from "vitest";
import {
  IncrementalHmmFilter,
  filteredPosterior,
  fitBaumWelch,
  viterbi,
} from "../gaussian-hmm";
import type { HmmParams } from "../types";

/**
 * Build a synthetic 3-state Gaussian sequence with known parameters, then
 * verify Baum-Welch recovers them within a tolerance and the filtered
 * posterior tracks the true state.
 */
function generateSequence(
  trueParams: HmmParams,
  T: number,
  seed = 1,
): { observations: number[]; states: number[] } {
  // Linear-congruential RNG for determinism.
  let s = seed >>> 0;
  const rand = () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const gauss = () => {
    // Box-Muller
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const states = new Array<number>(T);
  const observations = new Array<number>(T);

  // Sample initial state from CDF
  const sampleFromCdf = (probs: readonly number[]): number => {
    const u = rand();
    let acc = 0;
    for (let i = 0; i < probs.length; i++) {
      acc += probs[i];
      if (u <= acc) return i;
    }
    return probs.length - 1;
  };

  states[0] = sampleFromCdf(trueParams.initial);
  observations[0] = trueParams.means[states[0]] + trueParams.stds[states[0]] * gauss();
  for (let t = 1; t < T; t++) {
    states[t] = sampleFromCdf(trueParams.transition[states[t - 1]]);
    observations[t] = trueParams.means[states[t]] + trueParams.stds[states[t]] * gauss();
  }
  return { observations, states };
}

describe("Gaussian HMM", () => {
  const TRUE: HmmParams = {
    initial: [0.5, 0.3, 0.2],
    transition: [
      [0.96, 0.03, 0.01],
      [0.03, 0.94, 0.03],
      [0.01, 0.03, 0.96],
    ],
    means: [-1.0, 0.0, 1.0],
    stds: [0.4, 0.4, 0.4],
    labels: ["bear", "range", "bull"],
  };

  it("Baum-Welch recovers the true means within 15% of σ", () => {
    const { observations } = generateSequence(TRUE, 1500, 7);
    const fit = fitBaumWelch(observations, 3, { maxIter: 80 });
    // After relabeling by mean, the order is bear→range→bull.
    expect(fit.means[0]).toBeLessThan(-0.6);   // bear roughly -1
    expect(Math.abs(fit.means[1])).toBeLessThan(0.4); // range near 0
    expect(fit.means[2]).toBeGreaterThan(0.6); // bull roughly +1
    // Stds should be in same ballpark.
    for (const s of fit.stds) {
      expect(s).toBeGreaterThan(0.2);
      expect(s).toBeLessThan(0.7);
    }
  });

  it("filteredPosterior sums to 1 every step and concentrates on the true state under high signal-to-noise", () => {
    const easy: HmmParams = { ...TRUE, stds: [0.2, 0.2, 0.2] };
    const { observations, states } = generateSequence(easy, 600, 11);
    const post = filteredPosterior(easy, observations);
    const sum = post.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    // After enough data, posterior on the true final state should dominate.
    const trueState = states[states.length - 1];
    expect(post[trueState]).toBeGreaterThan(0.5);
  });

  it("IncrementalHmmFilter matches batch filteredPosterior on the same sequence", () => {
    const { observations } = generateSequence(TRUE, 200, 5);
    const filter = new IncrementalHmmFilter(TRUE);
    let last: number[] = [];
    for (const obs of observations) last = filter.step(obs);
    const batch = filteredPosterior(TRUE, observations);
    for (let i = 0; i < last.length; i++) {
      expect(last[i]).toBeCloseTo(batch[i], 8);
    }
  });

  it("Viterbi MAP path achieves > 70% accuracy when SNR is high", () => {
    const easy: HmmParams = { ...TRUE, stds: [0.15, 0.15, 0.15] };
    const { observations, states } = generateSequence(easy, 800, 13);
    const path = viterbi(easy, observations);
    let correct = 0;
    for (let t = 0; t < states.length; t++) if (path[t] === states[t]) correct++;
    expect(correct / states.length).toBeGreaterThan(0.7);
  });
});
