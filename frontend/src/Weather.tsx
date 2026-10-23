import { createContext, useContext } from "react";
import type { WeatherDay, WeatherHour } from "./api";
import { ParkTimeZoneContext } from "./parkDay";

/** OpenWeather condition code → emoji. Night icons ("01n") swap the sun out. */
export function weatherEmoji(id?: number, icon?: string): string {
  if (id == null) return "🌡️";
  const night = icon?.endsWith("n");
  if (id < 300) return "⛈️";
  if (id < 400) return "🌦️";
  if (id === 511) return "🌨️";
  if (id < 600) return id >= 520 ? "🌦️" : "🌧️";
  if (id < 700) return "🌨️";
  if (id < 800) return "🌫️";
  if (id === 800) return night ? "🌙" : "☀️";
  if (id === 801) return night ? "🌙" : "🌤️";
  if (id === 802) return "⛅";
  return "☁️";
}

/** Fahrenheit and mph in the US, mph in the UK, km/h elsewhere. */
const usesF = (tz: string) => tz.startsWith("America/");
const usesMph = (tz: string) => usesF(tz) || tz === "Europe/London";

export const fmtTemp = (c: number, tz: string): string =>
  `${Math.round(usesF(tz) ? (c * 9) / 5 + 32 : c)}°`;

const windNum = (ms: number, tz: string): number =>
  Math.round(usesMph(tz) ? ms * 2.237 : ms * 3.6);
const windUnit = (tz: string) => (usesMph(tz) ? "mph" : "km/h");

export const fmtWind = (ms: number, tz: string): string => `${windNum(ms, tz)} ${windUnit(tz)}`;

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Where the wind comes from, as a compass point ("SW" for 225°). */
export const compass = (deg: number): string => POINTS[Math.round(deg / 45) % 8];

/** An arrow pointing the way the wind blows: `deg` is where it comes from. */
function WindArrow({ deg }: { deg: number }) {
  return (
    <span className="wx-arrow" style={{ transform: `rotate(${deg + 180}deg)` }} aria-hidden="true">
      ↑
    </span>
  );
}

/** "11 mph SW, gusts 25 mph" */
function windText(w: { wind?: number; gust?: number; deg?: number }, tz: string): string | null {
  if (w.wind == null) return null;
  return [
    `wind ${fmtWind(w.wind, tz)}${w.deg != null ? ` from the ${compass(w.deg)}` : ""}`,
    w.gust != null ? `gusts ${fmtWind(w.gust, tz)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A park's daily weather by date, for the calendar cells and day bodies. */
export const WeatherDaysContext = createContext<Record<string, WeatherDay>>({});

/** Hourly weather for the queue day on screen, for the ride charts. */
export const WeatherHoursContext = createContext<WeatherHour[]>([]);

/** Rain that shows on a chart: a tenth of a millimetre in the hour. */
export const wet = (h: WeatherHour) => (h.rain ?? 0) + (h.snow ?? 0) >= 0.1;

function dayTitle(w: WeatherDay, tz: string): string {
  const parts = [
    w.fc ? "Forecast" : "Recorded",
    w.desc ? cap(w.desc) : null,
    `${fmtTemp(w.min, tz)} to ${fmtTemp(w.max, tz)}`,
    w.fc && w.pop != null ? `${Math.round(w.pop * 100)}% chance of rain` : null,
    w.rain ? `${w.rain} mm rain` : null,
    w.snow ? `${w.snow} mm snow` : null,
    windText(w, tz),
  ];
  return parts.filter(Boolean).join(", ");
}

/** One-line weather for a calendar cell. */
export function CellWeather({ iso }: { iso: string }) {
  const w = useContext(WeatherDaysContext)[iso];
  const tz = useContext(ParkTimeZoneContext);
  if (!w) return null;
  const wetMm = Math.round(((w.rain ?? 0) + (w.snow ?? 0)) * 10) / 10;
  const cls = "rc-line rc-weather" + (w.fc ? " wx-fc" : "");
  return (
    <>
      <div className={cls} title={dayTitle(w, tz)}>
        {weatherEmoji(w.id, w.icon)} {fmtTemp(w.min, tz)}-{fmtTemp(w.max, tz)}
        {w.fc && w.pop != null && w.pop >= 0.2 ? ` 💧${Math.round(w.pop * 100)}%` : ""}
      </div>
      {(w.wind != null || wetMm > 0) && (
        <div className={cls} title={dayTitle(w, tz)}>
          {w.wind != null && (
            <>
              💨 {windNum(w.wind, tz)}
              {w.gust != null && `-${windNum(w.gust, tz)}`} {windUnit(tz)}
              {w.deg != null && ` ${compass(w.deg)}`}
            </>
          )}
          {wetMm > 0 && `${w.wind != null ? " · " : ""}${wetMm}mm`}
        </div>
      )}
    </>
  );
}

/** The weather row in a day's detail body. */
export function BodyWeather({ iso }: { iso: string }) {
  const w = useContext(WeatherDaysContext)[iso];
  const tz = useContext(ParkTimeZoneContext);
  if (!w) return null;
  return (
    <div className={"rc-body-weather" + (w.fc ? " wx-fc" : "")}>
      {weatherEmoji(w.id, w.icon)} {w.fc ? "Forecast: " : ""}
      {dayTitle(w, tz).replace(/^(Forecast|Recorded), /, "")}
    </div>
  );
}

/** Hour by hour across the queue chart's window. Hours still to come are the
 *  forecast as of the last hourly fetch, and are marked as such. */
export function WeatherStrip({
  hours,
  date,
  domain,
}: {
  hours: WeatherHour[];
  date: string;
  domain: [number, number];
}) {
  const tz = useContext(ParkTimeZoneContext);
  const shown = hours.filter((h) => h.t + 60 > domain[0] && h.t < domain[1]);
  if (shown.length === 0) return null;
  const hourLabel = (t: number) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(
      Date.parse(`${date}T00:00:00Z`) + t * 60_000,
    );
  const anyFc = shown.some((h) => h.fc);
  return (
    <div className="wx-strip-wrap">
      <div className="wx-strip" role="list" aria-label="Weather by hour">
        {shown.map((h) => (
          <div
            key={h.t}
            role="listitem"
            className={"wx-hour" + (h.fc ? " wx-fc" : "") + (wet(h) ? " wx-wet" : "")}
            title={[
              `${hourLabel(h.t)}:00`,
              h.fc ? "forecast" : null,
              h.desc ? cap(h.desc) : null,
              h.feels != null ? `feels ${fmtTemp(h.feels, tz)}` : null,
              h.pop != null ? `${Math.round(h.pop * 100)}% chance of rain` : null,
              h.rain ? `${h.rain} mm rain` : null,
              h.snow ? `${h.snow} mm snow` : null,
              windText(h, tz),
            ]
              .filter(Boolean)
              .join(", ")}
          >
            <span className="wx-time">{hourLabel(h.t)}</span>
            <span className="wx-icon">{weatherEmoji(h.id, h.icon)}</span>
            <span className="wx-temp">{fmtTemp(h.temp, tz)}</span>
            {h.wind != null && (
              <span className="wx-wind">
                {h.deg != null && <WindArrow deg={h.deg} />}
                {windNum(h.wind, tz)}
                {h.gust != null && h.gust - h.wind >= 2.2 && (
                  <span className="wx-gust">-{windNum(h.gust, tz)}</span>
                )}
              </span>
            )}
            <span className="wx-rain">
              {h.rain || h.snow
                ? `${Math.round(((h.rain ?? 0) + (h.snow ?? 0)) * 10) / 10}mm`
                : h.fc && h.pop != null && h.pop >= 0.2
                  ? `${Math.round(h.pop * 100)}%`
                  : ""}
            </span>
          </div>
        ))}
      </div>
      <div className="wx-note">
        {anyFc && "Faded hours are forecast. "}Wind in {windUnit(tz)}, gusts after the dash;
        arrows point the way it blows. Weather from{" "}
        <a href="https://openweathermap.org/" target="_blank" rel="noreferrer noopener">
          OpenWeather
        </a>
        .
      </div>
    </div>
  );
}
