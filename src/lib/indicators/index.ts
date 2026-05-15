import type { Candle } from "@/lib/binance/types";

export interface IndicatorPoint {
  time: number;
  value: number;
}

export interface MACDPoint {
  time: number;
  macd: number;
  signal: number;
  histogram: number;
}

/**
 * Simple Moving Average
 */
export function sma(candles: Candle[], period: number): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length < period) return out;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

/**
 * Exponential Moving Average — seeded with SMA of first `period` candles.
 */
export function ema(candles: Candle[], period: number): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += candles[i].close;
  prev /= period;
  out.push({ time: candles[period - 1].time, value: prev });
  for (let i = period; i < candles.length; i++) {
    prev = candles[i].close * k + prev * (1 - k);
    out.push({ time: candles[i].time, value: prev });
  }
  return out;
}

/**
 * RSI (Wilder) — period typically 14.
 */
export function rsi(candles: Candle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  gain /= period;
  loss /= period;
  let rs = loss === 0 ? 100 : gain / loss;
  out.push({ time: candles[period].time, value: 100 - 100 / (1 + rs) });
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    rs = loss === 0 ? 100 : gain / loss;
    out.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });
  }
  return out;
}

/**
 * MACD — fast EMA, slow EMA, signal EMA of the MACD line.
 * Defaults: 12 / 26 / 9.
 */
export function macd(
  candles: Candle[],
  fast = 12,
  slow = 26,
  signal = 9,
): MACDPoint[] {
  if (candles.length < slow + signal) return [];
  const emaFast = ema(candles, fast);
  const emaSlow = ema(candles, slow);
  // align: emaSlow starts later
  const slowStartTime = emaSlow[0].time;
  const fastByTime = new Map(emaFast.map((p) => [p.time, p.value]));
  const macdLine: IndicatorPoint[] = [];
  for (const p of emaSlow) {
    const f = fastByTime.get(p.time);
    if (f !== undefined) macdLine.push({ time: p.time, value: f - p.value });
  }
  // signal = EMA of MACD line. Build synthetic candles for ema()
  const synth: Candle[] = macdLine.map((p) => ({
    time: p.time,
    open: p.value,
    high: p.value,
    low: p.value,
    close: p.value,
    volume: 0,
  }));
  const sig = ema(synth, signal);
  const sigByTime = new Map(sig.map((p) => [p.time, p.value]));
  const out: MACDPoint[] = [];
  for (const p of macdLine) {
    const s = sigByTime.get(p.time);
    if (s === undefined) continue;
    out.push({ time: p.time, macd: p.value, signal: s, histogram: p.value - s });
  }
  void slowStartTime;
  return out;
}
/**
 * ATR (Average True Range) — Wilder.
 * Mide volatilidad. Útil para stops dinámicos y position sizing.
 * Período típico: 14.
 */
export function atr(candles: Candle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length <= period) return out;

  // True Range para cada vela (desde i=1)
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    trs.push(tr);
  }

  // Primer ATR = SMA simple de los primeros `period` TRs
  let atrVal = 0;
  for (let i = 0; i < period; i++) atrVal += trs[i];
  atrVal /= period;
  out.push({ time: candles[period].time, value: atrVal });

  // Suavizado Wilder: ATR = (ATR_prev * (n-1) + TR) / n
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period;
    out.push({ time: candles[i + 1].time, value: atrVal });
  }
  return out;
}

export interface SupertrendPoint {
  time: number;
  value: number;
  direction: 1 | -1; // 1 = alcista, -1 = bajista
}

/**
 * Supertrend — basado en ATR. Filtro de tendencia con señal binaria clara.
 * Cuando la dirección cambia (flip), es una señal fuerte.
 * Defaults: período 10, multiplicador 3.
 */
export function supertrend(
  candles: Candle[],
  period = 10,
  multiplier = 3,
): SupertrendPoint[] {
  const out: SupertrendPoint[] = [];
  const atrData = atr(candles, period);
  if (atrData.length === 0) return out;

  // Mapear ATR por tiempo para acceso rápido
  const atrByTime = new Map(atrData.map((p) => [p.time, p.value]));

  let prevUpperBand = 0;
  let prevLowerBand = 0;
  let prevSupertrend = 0;
  let prevDirection: 1 | -1 = 1;
  let initialized = false;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const atrVal = atrByTime.get(c.time);
    if (atrVal === undefined) continue;

    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + multiplier * atrVal;
    const basicLower = hl2 - multiplier * atrVal;

    const upperBand =
      !initialized || basicUpper < prevUpperBand || candles[i - 1].close > prevUpperBand
        ? basicUpper
        : prevUpperBand;
    const lowerBand =
      !initialized || basicLower > prevLowerBand || candles[i - 1].close < prevLowerBand
        ? basicLower
        : prevLowerBand;

    let direction: 1 | -1;
    let stValue: number;

    if (!initialized) {
      direction = c.close > hl2 ? 1 : -1;
      stValue = direction === 1 ? lowerBand : upperBand;
      initialized = true;
    } else {
      if (prevSupertrend === prevUpperBand) {
        direction = c.close > upperBand ? 1 : -1;
      } else {
        direction = c.close < lowerBand ? -1 : 1;
      }
      stValue = direction === 1 ? lowerBand : upperBand;
    }

    out.push({ time: c.time, value: stValue, direction });
    prevUpperBand = upperBand;
    prevLowerBand = lowerBand;
    prevSupertrend = stValue;
    prevDirection = direction;
  }
  void prevDirection;
  return out;
}

/**
 * VWAP (Volume Weighted Average Price).
 * Se resetea cada día (UTC). Es el promedio del precio típico ponderado por volumen
 * desde la apertura del día — actúa como "imán" institucional intradía.
 */
export function vwap(candles: Candle[]): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length === 0) return out;

  let cumPV = 0;
  let cumVol = 0;
  let currentDay = -1;

  for (const c of candles) {
    // c.time está en segundos (UTC). Día UTC = floor(time / 86400)
    const day = Math.floor(c.time / 86400);
    if (day !== currentDay) {
      cumPV = 0;
      cumVol = 0;
      currentDay = day;
    }
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumVol += c.volume;
    out.push({
      time: c.time,
      value: cumVol === 0 ? typical : cumPV / cumVol,
    });
  }
  return out;
}