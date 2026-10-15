import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { platform } from "node:os";

const WINDOWS_REPLACE_COMMAND =
  "$ErrorActionPreference = 'Stop'; [System.IO.File]::Replace($env:SQL_STATIC_LINEAGE_ATOMIC_REPLACE_SOURCE, $env:SQL_STATIC_LINEAGE_ATOMIC_REPLACE_DESTINATION, [NullString]::Value)";

/** Keep the destination intact when Windows rejects Node's overwrite rename. */
export function atomicReplaceFile(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (renameError) {
    if (
      platform() !== "win32" ||
      (renameError as NodeJS.ErrnoException | null)?.code !== "EPERM" ||
      !existsSync(destination)
    )
      throw renameError;
    try {
      execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_REPLACE_COMMAND,
        ],
        {
          windowsHide: true,
          stdio: "pipe",
          env: {
            ...process.env,
            SQL_STATIC_LINEAGE_ATOMIC_REPLACE_SOURCE: source,
            SQL_STATIC_LINEAGE_ATOMIC_REPLACE_DESTINATION: destination,
          },
        },
      );
    } catch (nativeError) {
      throw new AggregateError(
        [renameError, nativeError],
        "ATOMIC_FILE_REPLACE_FAILED",
      );
    }
  }
}
