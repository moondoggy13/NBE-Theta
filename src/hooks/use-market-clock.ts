"use client";

import { useState, useEffect } from "react";
import type { MarketPhase } from "@/types/market";
import { MARKET_HOURS } from "@/lib/constants";

export function useMarketClock() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const h = now.getHours();
  const m = now.getMinutes();
  const t = h * 60 + m;
  const day = now.getDay();

  const preOpen = MARKET_HOURS.preMarketOpen.hour * 60 + MARKET_HOURS.preMarketOpen.minute;
  const open = MARKET_HOURS.marketOpen.hour * 60 + MARKET_HOURS.marketOpen.minute;
  const close = MARKET_HOURS.marketClose.hour * 60 + MARKET_HOURS.marketClose.minute;
  const afterClose = MARKET_HOURS.afterHoursClose.hour * 60 + MARKET_HOURS.afterHoursClose.minute;

  let phase: MarketPhase = "closed";
  if (day > 0 && day < 6) {
    if (t >= open && t < close) phase = "open";
    else if (t >= preOpen && t < open) phase = "pre-market";
    else if (t >= close && t < afterClose) phase = "after-hours";
  }

  let minutesToNextEvent = 0;
  let nextEvent = "Market Open";
  if (phase === "open") {
    minutesToNextEvent = close - t;
    nextEvent = "Market Close";
  } else if (phase === "pre-market") {
    minutesToNextEvent = open - t;
    nextEvent = "Market Open";
  } else if (phase === "after-hours") {
    minutesToNextEvent = afterClose - t;
    nextEvent = "After-Hours Close";
  }

  return { now, phase, nextEvent, minutesToNextEvent };
}
