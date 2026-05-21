import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MONTHLY_LIMIT = 100;

interface UsageData {
  periodStart: string;
  callCount: number;
}

function getUsagePath(): string {
  const dataDir = process.env['TRAINSPOTTER_DATA_DIR'] || join(dirname(new URL(import.meta.url).pathname), '..', '.data');
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, 'brfares-usage.json');
}

function getCurrentPeriodStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function loadUsage(): UsageData {
  try {
    const raw = readFileSync(getUsagePath(), 'utf-8');
    const data = JSON.parse(raw) as UsageData;
    if (data.periodStart === getCurrentPeriodStart()) {
      return data;
    }
  } catch {
    // file doesn't exist or is corrupt
  }
  return { periodStart: getCurrentPeriodStart(), callCount: 0 };
}

function saveUsage(data: UsageData): void {
  writeFileSync(getUsagePath(), JSON.stringify(data, null, 2));
}

export function recordFaresCall(): void {
  const usage = loadUsage();
  usage.callCount++;
  saveUsage(usage);
}

export function getUsageStatus(): { used: number; remaining: number; limit: number; period: string; warning: string | null } {
  const usage = loadUsage();
  const remaining = Math.max(0, MONTHLY_LIMIT - usage.callCount);
  let warning: string | null = null;

  if (remaining === 0) {
    warning = 'BR Fares API monthly limit REACHED (100/100). Further calls will fail until next billing period.';
  } else if (remaining <= 10) {
    warning = `BR Fares API nearly exhausted: ${usage.callCount}/${MONTHLY_LIMIT} used, ${remaining} remaining this period.`;
  } else if (remaining <= 25) {
    warning = `BR Fares API usage: ${usage.callCount}/${MONTHLY_LIMIT} (${remaining} remaining).`;
  }

  return {
    used: usage.callCount,
    remaining,
    limit: MONTHLY_LIMIT,
    period: usage.periodStart,
    warning,
  };
}

export function canMakeFaresCall(): boolean {
  const usage = loadUsage();
  return usage.callCount < MONTHLY_LIMIT;
}
