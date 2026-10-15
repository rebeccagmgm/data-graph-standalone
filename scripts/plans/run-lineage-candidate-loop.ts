import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

type JsonObject = Record<string, unknown>;

type ChildResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type CandidateResult = {
  index: number;
  task_id: string;
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "TIMEOUT" | "IGNORED";
  hard_failure: boolean;
  error?: string;
  rate_limit_signal?: boolean;
  external_infrastructure_signal?: boolean;
  recovery_attempted?: boolean;
  summary_path?: string;
  log_path: string;
};

type CandidateRun = {
  result: CandidateResult;
  rateLimitSignal: boolean;
  externalInfrastructureSignal: boolean;
};

const repoRoot = resolve(import.meta.dirname, "../..");
const defaultDataRoot = resolve(repoRoot, "../sql-static-lineage-data");
const loopScript = join(repoRoot, "scripts", "plans", "run-task-plan-loop.ts");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInt(name: string, fallback: number): number {
  const value = option(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function fraction(name: string, fallback: number): number {
  const value = option(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1)
    throw new Error(`${name} must be in (0, 1]`);
  return parsed;
}

function readTaskIds(path: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`task id file must be an array: ${path}`);
  return [
    ...new Set(
      parsed
        .map((value) => String(value).trim())
        .filter(Boolean),
    ),
  ];
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    process.kill(pid, "SIGTERM");
  }
}

function runChild(args: readonly string[], timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [tsxCli, ...args], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut,
      });
    });
  });
}

function lastJsonLine(text: string): JsonObject | undefined {
  for (const line of text.trim().split(/\r?\n/).reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as JsonObject;
    } catch {}
  }
  return undefined;
}

function lastUsefulErrorLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...lines]
    .reverse()
    .find(
      (line) =>
        !/^Node\.js v\d/.test(line) &&
        !/^\(node:\d+\)/.test(line) &&
        /(?:^Error:|COMMAND_EXEC|SecurityError|DNS_PROBE_FINISHED_NXDOMAIN|getaddrinfo\s+ENOTFOUND|Pre-navigation|browser navigate command timed out|task input collection failed)/i.test(
          line,
        ),
    );
}

function hasRateLimitSignal(text: string): boolean {
  return /(?:too many requests|rate[ -]?limit(?:ed|ing)?|throttl(?:ed|ing)?|quota exceeded|限流|请求过于频繁|频率过高|\b(?:http|status|status[_ -]?code|response[_ -]?status|error[_ -]?code)[^\r\n]{0,24}\b429\b|\b429\b[^\r\n]{0,24}(?:too many|rate|throttl))/i.test(
    text,
  );
}

function hasExternalInfrastructureSignal(text: string): boolean {
  if (/detached while handling command/i.test(text)) return true;
  return /(?:DNS_PROBE_FINISHED_NXDOMAIN|getaddrinfo\s+ENOTFOUND|pre-navigation[^\r\n]{0,120}(?:timed out|timeout)|browser navigate command timed out|failed to read the ['\"]cookie['\"] property|site reachability\/browser extension|metadata MCP:\s*UNAVAILABLE|portalSession:\s*UNKNOWN)/i.test(
    text,
  );
}

function hasIgnorableGfFdmTestSignal(text: string): boolean {
  return /Cannot map code project\/repository prefix:\s*GF_FDM_TEST/i.test(text);
}

async function main(): Promise<void> {
  const taskIdFile = resolve(
    option("--task-ids-file") ??
      join(repoRoot, "tmp", "inspect-results", "batch", "lineage-edge-task-ids.json"),
  );
  const dataRoot = resolve(option("--data-root") ?? defaultDataRoot);
  const offset = Number(option("--offset") ?? "0");
  const limit = option("--limit") === undefined ? undefined : positiveInt("--limit", 1);
  const batchSize = positiveInt("--batch-size", 10);
  // OpenCLI's browser-backed SZData session cannot safely navigate two tabs
  // at once. Keep external collection serial; parallelism can be introduced
  // later for the local-only inspection phase.
  const concurrency = positiveInt("--concurrency", 1);
  if (concurrency > 1)
    throw new Error(
      "--concurrency > 1 is unsafe while SZData collection uses the shared browser session; use 1",
    );
  const timeoutMs = positiveInt("--task-timeout-ms", 120_000);
  const maxConsecutiveFailures = positiveInt("--max-consecutive-failures", 3);
  const maxFailureRate = fraction("--max-failure-rate", 0.3);
  const ignoreExternalInfrastructure = process.argv.includes(
    "--ignore-external-infrastructure",
  );

  if (!existsSync(taskIdFile)) throw new Error(`task id file not found: ${taskIdFile}`);
  if (!Number.isInteger(offset) || offset < 0) throw new Error("--offset must be a non-negative integer");

  const allTaskIds = readTaskIds(taskIdFile);
  const taskIds = allTaskIds.slice(offset, limit === undefined ? undefined : offset + limit);
  if (taskIds.length === 0) throw new Error("no task ids selected");

  const outputPath = resolve(
    option("--output") ??
      join(repoRoot, "tmp", "inspect-results", "batch", "lineage-workbook-loop.summary.json"),
  );
  const logRoot = join(repoRoot, "tmp", "inspect-results", "batch", "lineage-workbook-logs");
  mkdirSync(logRoot, { recursive: true });
  const results: CandidateResult[] = [];
  let consecutiveFailures = 0;
  let paused = false;
  let pauseReason: string | undefined;

  const persistSummary = (
    currentPaused: boolean,
    currentPauseReason: string | undefined,
  ): void => {
    const summary = {
      pipeline: "workbook task_id -> task-source/input-pack -> plan-adapter",
      temporary: true,
      task_id_file: taskIdFile,
      data_root: dataRoot,
      selected_offset: offset,
      selected_count: taskIds.length,
      processed_count: results.length,
      remaining_count: allTaskIds.length - offset - results.length,
      batch_size: batchSize,
      concurrency,
      task_timeout_ms: timeoutMs,
      max_consecutive_failures: maxConsecutiveFailures,
      max_failure_rate: maxFailureRate,
      ignore_external_infrastructure: ignoreExternalInfrastructure,
      paused: currentPaused,
      pause_reason: currentPauseReason,
      counts: {
        success: results.filter((item) => item.status === "SUCCESS").length,
        partial: results.filter((item) => item.status === "PARTIAL").length,
        failed: results.filter((item) => item.status === "FAILED").length,
        timeout: results.filter((item) => item.status === "TIMEOUT").length,
        ignored: results.filter((item) => item.status === "IGNORED").length,
      },
      results,
    };
    mkdirSync(join(repoRoot, "tmp", "inspect-results", "batch"), {
      recursive: true,
    });
    writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  };

  async function runCandidate(index: number, taskId: string): Promise<CandidateRun> {
    const absoluteIndex = offset + index;
    console.error(JSON.stringify({
      progress: "candidate_started",
      index: absoluteIndex + 1,
      total: allTaskIds.length,
      task_id: taskId,
    }));

    const childArgs = [
      loopScript,
      "--task-ids",
      taskId,
      "--collect-task-input",
      "--fetch-szdata",
    ];
    let child = await runChild(childArgs, timeoutMs);
    let logText = `${child.stdout}\n--- STDERR ---\n${child.stderr}`;
    let recoveryAttempted = false;
    // A timeout during the SZData-backed run can be caused by metadata
    // retrieval, while the local task/table evidence is already sufficient to
    // produce a truthful PARTIAL result. Retry once without SZData before
    // classifying the candidate as a hard batch failure.
    if (child.timedOut) {
      recoveryAttempted = true;
      const localFallback = await runChild(
        [
          loopScript,
          "--task-ids",
          taskId,
          "--collect-task-input",
          "--no-fetch-szdata",
        ],
        timeoutMs,
      );
      logText += `\n--- LOCAL INPUT FALLBACK ---\n${localFallback.stdout}\n--- STDERR ---\n${localFallback.stderr}`;
      child = localFallback;
    }
    // Do not automatically bind or open the SZData portal here. The existing
    // browser session should be reused; on bridge/infrastructure failure the
    // caller must pause instead of refreshing or retrying through a new page.
    const logPath = join(logRoot, `${absoluteIndex + 1}-${taskId}.log`);
    writeFileSync(logPath, logText, "utf8");

    const summaryEvent = lastJsonLine(child.stdout);
    const summaryPath =
      typeof summaryEvent?.path === "string" ? summaryEvent.path : undefined;
    let status: CandidateResult["status"] = "FAILED";
    let error: string | undefined;
    if (child.timedOut) {
      status = "TIMEOUT";
      error = `task exceeded ${timeoutMs}ms and its process tree was terminated`;
    } else if (child.exitCode === 0 && summaryPath !== undefined) {
      try {
        const batch = JSON.parse(readFileSync(summaryPath, "utf8")) as JsonObject;
        const first = Array.isArray(batch.results) ? batch.results[0] : undefined;
        status = first && typeof first === "object" && first.status === "PARTIAL" ? "PARTIAL" : "SUCCESS";
        if (first && typeof first === "object" && typeof first.error === "string") error = first.error;
      } catch (parseError) {
        status = "FAILED";
        error = `cannot read child summary: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
      }
    } else {
      error =
        lastUsefulErrorLine(`${child.stderr}\n${child.stdout}`) ??
        `child exit code ${child.exitCode}`;
    }

    // Keep signals from every attempt. A timed-out SZData attempt may be
    // followed by a successful local fallback; replacing `child` must not
    // erase a rate-limit or infrastructure signal from the first attempt.
    const allAttemptText = `${logText}\n${error ?? ""}`;
    const rateLimitSignal = hasRateLimitSignal(allAttemptText);
    const externalInfrastructureSignal =
      hasExternalInfrastructureSignal(allAttemptText);
    const ignorableGfFdmTest = hasIgnorableGfFdmTestSignal(
      `${child.stdout}\n${child.stderr}\n${error ?? ""}`,
    );
    const ignoredExternalInfrastructure =
      ignoreExternalInfrastructure && externalInfrastructureSignal;
    if (ignorableGfFdmTest) status = "IGNORED";
    else if (ignoredExternalInfrastructure) status = "IGNORED";
    const hardFailure = status === "FAILED" || status === "TIMEOUT";
    consecutiveFailures = hardFailure ? consecutiveFailures + 1 : 0;
    const result: CandidateResult = {
      index: absoluteIndex,
      task_id: taskId,
      status,
      hard_failure: hardFailure,
      ...(error ? { error } : {}),
      ...(rateLimitSignal ? { rate_limit_signal: true } : {}),
      ...(externalInfrastructureSignal
        ? { external_infrastructure_signal: true }
        : {}),
      ...(recoveryAttempted ? { recovery_attempted: true } : {}),
      ...(ignorableGfFdmTest ? { ignored_reason: "GF_FDM_TEST" } : {}),
      ...(ignoredExternalInfrastructure
        ? { ignored_reason: "EXTERNAL_INFRASTRUCTURE" }
        : {}),
      ...(summaryPath ? { summary_path: summaryPath } : {}),
      log_path: logPath,
    };
    console.error(JSON.stringify({ progress: "candidate_finished", ...result }));
    return { result, rateLimitSignal, externalInfrastructureSignal: externalInfrastructureSignal && !ignoredExternalInfrastructure };
  }

  for (let batchStart = 0; batchStart < taskIds.length && !paused; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, taskIds.length);
    const batchRuns = new Array<CandidateRun | undefined>(batchEnd - batchStart);
    let next = 0;
    async function worker(): Promise<void> {
      while (true) {
        const local = next++;
        if (local >= batchRuns.length || paused) return;
        const index = batchStart + local;
        const run = await runCandidate(index, taskIds[index]!);
        batchRuns[local] = run;
        // Persist after every completed candidate so an interruption or an
        // immediate rate-limit stop leaves a usable checkpoint, even before
        // the enclosing batch reaches its checkpoint boundary.
        results.push(run.result);
        persistSummary(false, undefined);

        // With serial execution, stop before starting the next candidate as
        // soon as the child reports a rate-limit or infrastructure signal.
        // The batch-level check below remains as a safety net for callers
        // that later introduce bounded concurrency.
        if (run.rateLimitSignal) {
          paused = true;
          pauseReason =
            "explicit rate-limit/throttling signal detected in child output";
          return;
        }
        if (run.externalInfrastructureSignal) {
          paused = true;
          pauseReason =
            "external SZData/browser/network infrastructure failure detected";
          return;
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, batchRuns.length) }, () => worker()),
    );
    const rateLimitRun = batchRuns.find(
      (run) => run?.rateLimitSignal === true,
    );
    const infrastructureRun = batchRuns.find(
      (run) => run?.externalInfrastructureSignal === true,
    );
    if (rateLimitRun !== undefined) {
      paused = true;
      pauseReason = "explicit rate-limit/throttling signal detected in child output";
    } else if (infrastructureRun !== undefined) {
      paused = true;
      pauseReason = "external SZData/browser/network infrastructure failure detected";
    }
    const batchResults = batchRuns
      .filter((run): run is CandidateRun => run !== undefined)
      .map((run) => run.result);
    const batchHardFailures = batchResults.filter((item) => item.hard_failure).length;
    consecutiveFailures = batchResults.at(-1)?.hard_failure
      ? consecutiveFailures + 1
      : 0;
    if (
      !paused &&
      (consecutiveFailures >= maxConsecutiveFailures ||
        batchHardFailures / Math.max(batchResults.length, 1) >= maxFailureRate)
    ) {
      paused = true;
      pauseReason =
        consecutiveFailures >= maxConsecutiveFailures
          ? `consecutive hard failures reached ${maxConsecutiveFailures}`
          : `hard failure rate reached ${maxFailureRate} in the latest ${batchResults.length} task(s)`;
    }
    if (!paused && batchResults.length === batchEnd - batchStart)
      console.error(JSON.stringify({ progress: "batch_checkpoint", completed: offset + batchEnd - 1, total: allTaskIds.length }));
  }

  persistSummary(paused, pauseReason);
  console.log(JSON.stringify({ progress: "guarded_summary_written", path: outputPath, paused, processed: results.length }));
}

await main();
