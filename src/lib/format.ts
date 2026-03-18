import chalk from 'chalk';

const AGENT_COLORS: Record<string, chalk.Chalk> = {
  'claude-code': chalk.cyan,
  'openclaw': chalk.green,
  'codex': chalk.yellow,
  'chatgpt': chalk.magenta,
};

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function agentColor(agent: string): string {
  const colorFn = AGENT_COLORS[agent] ?? chalk.white;
  return colorFn(agent);
}

export function agentTag(agent: string, padWidth = 12): string {
  const colorFn = AGENT_COLORS[agent] ?? chalk.white;
  return colorFn(`[${agent}]`.padEnd(padWidth));
}

export function sectionHeader(title: string): string {
  return chalk.bold.underline(title);
}

export function dimLabel(label: string, width: number): string {
  return chalk.dim(label.padEnd(width));
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return 'N/A';
  const pct = Math.round(delta * 100);
  if (pct >= 0) return chalk.green(`+${pct}%`);
  return chalk.red(`${pct}%`);
}
