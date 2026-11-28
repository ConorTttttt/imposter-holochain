import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { build } = await import(new URL("../../ui/node_modules/esbuild/lib/main.js", import.meta.url));
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node build-gameplay-page.mjs <patched-demo> <gameplay-demo>");

const bundle = await build({
  absWorkingDir: root,
  stdin: {
    contents: `export { mountBrowserMap } from "./ui/src/browser/map.ts";
      export { BROWSER_TASK_COUNTS, BROWSER_DEFAULT_TASK_COUNT, browserTaskList } from "./ui/src/browser/tasks.ts";
      export { mountBrowserMeetings } from "./ui/src/browser/meetings.ts";
      export { mountBrowserChat } from "./ui/src/browser/chat.ts";`,
    resolveDir: root,
  },
  bundle: true, write: false, platform: "browser", format: "iife",
  globalName: "imposterBrowserMap", target: "es2022",
});
const style = await readFile(resolve(root, "release/browser-alpha/frontend/gameplay.css"), "utf8");
const html = await readFile(input, "utf8");
await writeFile(output, html.replace("</style>", () => style + "\n</style>")
  .replace('<script type="module">', () => '<script type="module">\n' + bundle.outputFiles[0].text));
