import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = resolve(repositoryRoot, "package.json");
const lockfilePath = resolve(repositoryRoot, "package-lock.json");
const nodeModulesRoot = resolve(repositoryRoot, "node_modules");

function readPackageJson() {
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${packageJsonPath}: ${error.message}`);
  }
}

function directDependencies(packageJson) {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ];
}

function missingDependencies(packageJson) {
  return directDependencies(packageJson).filter(
    (name) => !existsSync(resolve(nodeModulesRoot, name, "package.json")),
  );
}

function installDependencies() {
  if (!existsSync(lockfilePath)) {
    throw new Error(
      "package-lock.json is required; refusing to fall back to an unlocked install",
    );
  }

  console.log(
    "[deps] node_modules is missing or incomplete; running npm ci from package-lock.json",
  );

  const npmCliPath = resolve(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const npmCommand = existsSync(npmCliPath)
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const npmArguments = existsSync(npmCliPath)
    ? [npmCliPath, "ci", "--include=dev", "--ignore-scripts"]
    : ["ci", "--include=dev", "--ignore-scripts"];
  const result = spawnSync(npmCommand, npmArguments, {
    cwd: repositoryRoot,
    stdio: "inherit",
    // Windows cannot spawn a .cmd shim without a shell. The normal path
    // above invokes npm-cli.js directly and therefore keeps shell parsing
    // disabled; this is only a fallback for non-standard Node installs.
    shell: process.platform === "win32" && !existsSync(npmCliPath),
  });

  if (result.error) {
    throw new Error(`Unable to start ${npmCommand}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

try {
  const packageJson = readPackageJson();
  const missing = missingDependencies(packageJson);

  if (missing.length === 0) {
    process.exit(0);
  }

  console.log(`[deps] missing direct packages: ${missing.join(", ")}`);
  installDependencies();

  const stillMissing = missingDependencies(packageJson);
  if (stillMissing.length > 0) {
    throw new Error(
      `npm ci completed but packages are still missing: ${stillMissing.join(", ")}`,
    );
  }
} catch (error) {
  console.error(`[deps] ${error.message}`);
  process.exit(1);
}
