import type { ReportMode } from "../../contracts/index.ts";

const modeLabels: Record<ReportMode, string> = {
  keyword: "关键词",
  post: "单个作品",
  creator: "博主",
};

export function formatInteger(value: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.trunc(Math.abs(value)));
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",")}`;
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatScore(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

export function formatGeneratedAt(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u.exec(value);
  const offset = /([+-]\d{2}:\d{2}|Z)$/u.exec(value)?.[1];
  const zone = offset ? ` UTC${offset === "Z" || offset === "+00:00" ? "" : offset}` : "";
  return match ? `${match[1]} ${match[2]}${zone}` : value;
}

export function formatMode(mode: ReportMode): string {
  return modeLabels[mode];
}
