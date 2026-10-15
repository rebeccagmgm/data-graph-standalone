import { appendFileSync, createWriteStream, mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";

import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  resolveScheduleEvidenceCacheRoot,
} from "../../evidence/schedule-evidence-cache.ts";

type Direction = "up" | "down";

export interface HoraeRelationSupervisorOptions {
  readonly cacheRoot?: string;
  readonly directions?: readonly Direction[];
  readonly order?: "asc" | "desc";
  readonly intervalMs?: number;
  readonly maxErrors?: number;
  readonly restartDelayMs?: number;
  readonly maxRestarts?: number;
  readonly logRoot?: string;
  readonly repoRoot?: string;
}

export interface HoraeRelationWorkerExit {
  readonly direction: Direction;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly restartCount: number;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_MAX_ERRORS = 10;
const DEFAULT_RESTART_DELAY_MS = 60_000;
const DEFAULT_MAX_RESTARTS = 10;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function integerOption(
  name: string,
  fallback: number,
  allowZero = false,
): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(
      `${name.slice(2).toUpperCase().replaceAll("-", "_")}_INVALID`,
    );
  }
  return value;
}

function directionOption(): readonly Direction[] {
  const value = option("--direction") ?? "both";
  if (value === "both") return ["up", "down"];
  if (value === "up" || value === "down") return [value];
  throw new Error("DIRECTION_INVALID");
}

export function horaeRelationWorkerArguments(
  cacheRoot: string,
  direction: Direction,
  order: "asc" | "desc",
  intervalMs: number,
  maxErrors: number,
): readonly string[] {
  return [
    "run",
    "input-pack:fill-horae-relation-sqlite",
    "--",
    "--cache-root",
    cacheRoot,
    "--direction",
    direction,
    "--order",
    order,
    "--interval-ms",
    String(intervalMs),
    "--max-errors",
    String(maxErrors),
  ];
}

export function shouldRestartWorker(
  code: number | null,
  signal: NodeJS.Signals | null,
): boolean {
  return code !== 0 || signal !== null;
}

function logLine(logPath: string, message: string): void {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function workerLogPath(
  logRoot: string,
  direction: Direction,
  suffix: string,
): string {
  return join(logRoot, `${direction}.${suffix}.log`);
}

export async function superviseHoraeRelationSqlite(
  options: HoraeRelationSupervisorOptions = {},
): Promise<readonly HoraeRelationWorkerExit[]> {
  const cacheRoot = resolve(
    options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  );
  const directions = options.directions ?? ["up", "down"];
  const order = options.order ?? "asc";
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxErrors = options.maxErrors ?? DEFAULT_MAX_ERRORS;
  const restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const logRoot = resolve(
    options.logRoot ??
      join(
        resolveScheduleEvidenceCacheRoot(cacheRoot),
        "relation-sqlite-worker",
      ),
  );
  mkdirSync(logRoot, { recursive: true });
  const supervisorLog = join(logRoot, "supervisor.log");
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const exits: HoraeRelationWorkerExit[] = [];
  const children = new Map<Direction, ChildProcess>();
  let shuttingDown = false;

  const stopChildren = (): void => {
    shuttingDown = true;
    for (const child of children.values()) child.kill();
  };
  process.once("SIGINT", stopChildren);
  process.once("SIGTERM", stopChildren);

  await Promise.all(
    directions.map(async (direction) => {
      let restartCount = 0;
      while (!shuttingDown) {
        const stdout = createWriteStream(
          workerLogPath(logRoot, direction, "stdout"),
          {
            flags: "a",
          },
        );
        const stderr = createWriteStream(
          workerLogPath(logRoot, direction, "stderr"),
          {
            flags: "a",
          },
        );
        const child = spawn(
          executable,
          horaeRelationWorkerArguments(
            cacheRoot,
            direction,
            order,
            intervalMs,
            maxErrors,
          ),
          {
            cwd: repoRoot,
            env: { ...process.env, NODE_NO_WARNINGS: "1" },
            shell: process.platform === "win32",
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        child.stdout?.pipe(stdout);
        child.stderr?.pipe(stderr);
        children.set(direction, child);
        logLine(
          supervisorLog,
          `${direction} started pid=${child.pid ?? "unknown"} restart=${restartCount}`,
        );
        const [code, signal] = await new Promise<
          [number | null, NodeJS.Signals | null]
        >((resolveExit) => {
          child.once("close", (exitCode, exitSignal) => {
            resolveExit([exitCode, exitSignal]);
          });
        });
        children.delete(direction);
        exits.push({ direction, code, signal, restartCount });
        if (shuttingDown || !shouldRestartWorker(code, signal)) {
          logLine(
            supervisorLog,
            `${direction} completed code=${code ?? "null"} signal=${signal ?? "none"}`,
          );
          return;
        }
        if (restartCount >= maxRestarts) {
          logLine(
            supervisorLog,
            `${direction} stopped after max-restarts=${maxRestarts} code=${code ?? "null"} signal=${signal ?? "none"}`,
          );
          return;
        }
        restartCount += 1;
        logLine(
          supervisorLog,
          `${direction} failed code=${code ?? "null"} signal=${signal ?? "none"}; restart in ${restartDelayMs}ms`,
        );
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, restartDelayMs),
        );
      }
    }),
  );
  process.removeListener("SIGINT", stopChildren);
  process.removeListener("SIGTERM", stopChildren);
  return exits;
}

async function main(): Promise<void> {
  const result = await superviseHoraeRelationSqlite({
    cacheRoot: option("--cache-root"),
    directions: directionOption(),
    order: (option("--order") as "asc" | "desc" | undefined) ?? "asc",
    intervalMs: integerOption("--interval-ms", DEFAULT_INTERVAL_MS, true),
    maxErrors: integerOption("--max-errors", DEFAULT_MAX_ERRORS),
    restartDelayMs: integerOption(
      "--restart-delay-ms",
      DEFAULT_RESTART_DELAY_MS,
      true,
    ),
    maxRestarts: integerOption("--max-restarts", DEFAULT_MAX_RESTARTS),
    logRoot: option("--log-root"),
  });
  if (result.some((item) => shouldRestartWorker(item.code, item.signal))) {
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("supervise-horae-relation-sqlite.ts")) {
  await main();
}
