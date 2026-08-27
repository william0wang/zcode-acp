/**
 * Shared precision rule for quota percentage readouts: backends report usage
 * in 0.1 steps (84.3), so cap the printed value at one fractional digit
 * instead of letting raw floats spill their full representation. Callers own
 * the surrounding rendering (bar overlay text vs padded table column).
 */
export function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}
