import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export async function sandboxPage(runtime) {
  if (!runtime) throw new Error("Pass installed Playwright node_modules");
  const { chromium } = await import(
    pathToFileURL(resolve(runtime, "playwright/index.mjs"))
  );
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  await page.route("**/*", (r) => r.abort());
  // Test generated markup in an isolated about:blank document. No file URL navigation.
  await page.setContent(
    await readFile(resolve(root, "docs/processing-map-pdata.html"), "utf8"),
  );
  const at = async (hash) => {
    await page.waitForURL(
      (u) => u.hash === `#${hash}` || (hash === "overview" && !u.hash),
    );
    await page.locator("h1").waitFor();
  };
  const go = async (hash) => {
    await page.evaluate((h) => {
      location.hash = h;
    }, hash);
    await at(hash);
  };
  return { browser, page, errors, requests, at, go };
}
