import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { build } = await import(new URL("../../ui/node_modules/esbuild/lib/main.js", import.meta.url));
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node build-gameplay-page.mjs <patched-demo> <gameplay-demo>");

const bundle = await build({
  stdin: {
    contents: 'import { mountBrowserMap } from "./ui/src/browser/map.ts"; export { mountBrowserMap };',
    resolveDir: root,
  },
  bundle: true, write: false, platform: "browser", format: "iife",
  globalName: "imposterBrowserMap", target: "es2022",
});
const style = await readFile(resolve(root, "release/browser-alpha/frontend/gameplay.css"), "utf8");
const map = `<section id="gameplay-map" class="panel" aria-label="Ship map" hidden>
<div class="gameplay-header"><h2 id="ship-location">Navigator Bridge</h2><span id="movement-status" role="status"></span></div>
<canvas tabindex="0" aria-label="Ship map. Use WASD or the arrow keys to move."></canvas>
<p>Focus the map, then use WASD or the arrow keys to move.</p>
<ol id="movement-players" aria-label="Player movement connections"></ol>
</section>`;

function replaceOnce(html, needle, replacement) {
  if (html.split(needle).length !== 2) throw new Error(`Accepted browser demo fixture changed: ${needle}`);
  return html.replace(needle, () => replacement);
}

let html = await readFile(input, "utf8");
html = replaceOnce(html, "</style>", style + "\n</style>");
html = replaceOnce(html, 'Three-player browser demo', 'Three-player browser gameplay');
html = replaceOnce(html, '<section class="panel" aria-label="Lobby players">', map + '\n<section class="panel" aria-label="Lobby players">');
// Inline the bundle to keep the exact static release inventory and hashing.
const code = bundle.outputFiles[0].text;
html = replaceOnce(html, '<script type="module">', '<script type="module">\n' + code +
  '\nconst browserMap = imposterBrowserMap.mountBrowserMap();');
const buttonsEnd = 'task.disabled=!ready||task.hidden||Boolean(latestState?.my_tasks_done?.includes(demoTask.id));';
html = replaceOnce(html, buttonsEnd, buttonsEnd + `
 browserMap.update({authenticated: badge.dataset.status === 'ready', state: latestState,
   dna: meta?.dna_hash, seed: meta?.network_seed, identity, hash: holoHash,
   sign: hc?.signJoiningNonce?.bind(hc)});
`);
html = replaceOnce(html,
  " if((state?.my_role===0||state?.my_role===1)&&state?.my_seat!=null)\n  verifiedRole=state.my_role;\n",
  "");
html = replaceOnce(html,
  " }catch(e){message(errorText(e),true);}\n finally{refreshing=false;}",
  ` }catch(e){
   if(client===hc&&epoch===connectionEpoch){
    verifiedRole=null;latestState=null;roleScope=null;
    $('my-role').textContent='Waiting for verified game state.';
    setStatus('error','Connection unavailable');message(errorText(e),true);updateButtons();
   }
 }finally{refreshing=false;}`);
await writeFile(output, html);
