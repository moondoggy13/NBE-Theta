import { toZonedTime, format } from "date-fns-tz";

const ET = "America/New_York";

export function getETNow(): Date {
  return toZonedTime(new Date(), ET);
}

export function getETMinuteOfDay(d?: Date): number {
  const et = d ? toZonedTime(d, ET) : getETNow();
  return et.getHours() * 60 + et.getMinutes();
}

export function formatETDate(d?: Date): string {
  return format(d ?? new Date(), "yyyy-MM-dd", { timeZone: ET });
}

export function isWeekend(d?: Date): boolean {
  const et = d ? toZonedTime(d, ET) : getETNow();
  const day = et.getDay();
  return day === 0 || day === 6;
}

export function msUntilET(targetHour: number, targetMinute: number): number {
  const now = new Date();
  const et = toZonedTime(now, ET);
  const target = new Date(et);
  target.setHours(targetHour, targetMinute, 0, 0);
  let ms = target.getTime() - et.getTime();
  if (ms < 0) ms += 24 * 60 * 60 * 1000; // next day
  return ms;
}

export function msUntilNextTradingDay(): number {
  const et = getETNow();
  const day = et.getDay();
  let daysToAdd = 1;
  if (day === 5) daysToAdd = 3;      // Friday → Monday
  else if (day === 6) daysToAdd = 2;  // Saturday → Monday

  const target = new Date(et);
  target.setDate(target.getDate() + daysToAdd);
  target.setHours(5, 55, 0, 0); // Wake at 05:55 ET
  return Math.max(0, target.getTime() - et.getTime());
}
