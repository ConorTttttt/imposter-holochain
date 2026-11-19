import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { build } = await import(new URL("../../ui/node_modules/esbuild/lib/main.js", import.meta.url));
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node build-gameplay-page.mjs <patched-demo> <gameplay-demo>");

const bundle = await build({
  stdin: {
    contents: `export { mountBrowserMap } from "./ui/src/browser/map.ts";
      export { BROWSER_TASK_COUNTS, BROWSER_DEFAULT_TASK_COUNT, browserTaskList } from "./ui/src/browser/tasks.ts";`,
    resolveDir: root,
  },
  bundle: true, write: false, platform: "browser", format: "iife",
  globalName: "imposterBrowserMap", target: "es2022",
});
const style = await readFile(resolve(root, "release/browser-alpha/frontend/gameplay.css"), "utf8");
const map = `<section id="gameplay-map" class="panel" aria-label="Ship map" hidden>
<div class="gameplay-header"><h2 id="ship-location">Navigator Bridge</h2><span id="movement-status" role="status"></span></div>
<canvas tabindex="0" aria-label="Ship map. Use WASD or the arrow keys to move."></canvas>
<p>Focus the map, then use WASD or the arrow keys to move. Press E to use a nearby console.</p>
<div class="actions"><button id="use-console" type="button" disabled>Use console (E)</button></div>
<p id="console-status" role="status"></p>
<ul id="console-tasks" aria-label="Your tasks"></ul>
<dialog id="console-game" aria-labelledby="console-title">
  <div class="gameplay-header"><h3 id="console-title"></h3>
  <form method="dialog"><button type="submit" class="secondary">Close</button></form></div>
  <div class="console-body"></div>
</dialog>
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
html = replaceOnce(html, '<button id="create-lobby" disabled>Create lobby</button>',
  '<button id="create-lobby" disabled>Create lobby</button>\n' +
  '<label id="task-count-label" hidden>Tasks per player <select id="task-count"></select></label>');
html = replaceOnce(html, '<button id="complete-task" class="secondary" type="button" hidden disabled>Align Engine Output</button>\n', '');
html = replaceOnce(html, 'One shared task is available in this demo.',
  'Complete the tasks at their marked consoles.');
html = replaceOnce(html,
  "const start=$('start-round'),task=$('complete-task'),progress=$('task-progress');\n" +
  "// The original engine console from ui/src/game/world.ts is the sole task.\n" +
  "const demoTask={id:0,name:'Align Engine Output',x:1240,y:1560};",
  `const start=$('start-round'),progress=$('task-progress'),taskCount=$('task-count');
for(const count of imposterBrowserMap.BROWSER_TASK_COUNTS){
 const option=new Option(String(count),String(count),false,count===imposterBrowserMap.BROWSER_DEFAULT_TASK_COUNT);
 taskCount.add(option);
}`);
// Inline the bundle to keep the exact static release inventory and hashing.
const code = bundle.outputFiles[0].text;
html = replaceOnce(html, '<script type="module">', '<script type="module">\n' + code +
  '\nconst browserMap = imposterBrowserMap.mountBrowserMap();');
const taskButtons = ` task.hidden=!(verifiedRole===0&&latestState?.phase==='playing'&&
   latestState.tasks?.some(item=>item.id===demoTask.id));
 task.disabled=!ready||task.hidden||Boolean(latestState?.my_tasks_done?.includes(demoTask.id));`;
html = replaceOnce(html, taskButtons, `
 $('task-count-label').hidden=identity!==meta?.host_agent_pub_key||Boolean(latestState?.code);
 taskCount.disabled=!ready;
 browserMap.update({authenticated: badge.dataset.status === 'ready', state: latestState,
   dna: meta?.dna_hash, seed: meta?.network_seed, identity, hash: holoHash,
   sign: hc?.signJoiningNonce?.bind(hc), role: verifiedRole, submit: completeConsoleTask});
`);
html = replaceOnce(html, "async function roundAction(kind){", "async function roundAction(){");
html = replaceOnce(html, `  if(kind==='start'){
   if(latestState?.phase==='lobby'){
    const record=await client.callZome({zome_name:'game',fn_name:'commit_roles_only',payload:null});
    window.dispatchEvent(new CustomEvent('imposter:action',{detail:{kind,record}}));
   }
   if(!latestState?.tasks?.length)
    await client.callZome({zome_name:'game',fn_name:'publish_tasks',payload:[demoTask]});
   message('Round started.');
  }else{
   await client.callZome({zome_name:'game',fn_name:'complete_task',payload:demoTask.id});
   message('Task complete.');
  }`, `  const state=latestState;
  if(state?.is_host!==true||!['lobby','playing'].includes(state.phase))return;
  if(state.phase==='lobby'){
   const record=await client.callZome({zome_name:'game',fn_name:'commit_roles_only',payload:null});
   window.dispatchEvent(new CustomEvent('imposter:action',{detail:{kind:'start',record}}));
  }
  if(!state.tasks?.length){
   const tasks=imposterBrowserMap.browserTaskList(state.task_target,state.player_count-state.impostor_count);
   await client.callZome({zome_name:'game',fn_name:'publish_tasks',payload:tasks});
  }
  message('Round started.');`);
html = replaceOnce(html, "async function act(kind){", `async function completeConsoleTask(id){
 const client=hc,epoch=connectionEpoch,state=latestState;
 if(!client||busy||verifiedRole!==0||state?.phase!=='playing'||
    !state.tasks.some(task=>task.id===id)||state.my_tasks_done.includes(id))
  throw Error('This console is unavailable.');
 busy=true;updateButtons();
 try{
  const status=await client.getConnectionStatus();
  if(status?.authenticated!==true||status?.wsHealthy!==true||
     await client.callZome({zome_name:'game',fn_name:'get_verified_browser_role',payload:null})!==0||
     client!==hc||epoch!==connectionEpoch)
   throw Error('Crew role is unavailable.');
  await client.callZome({zome_name:'game',fn_name:'complete_task',payload:id});
 }finally{
  if(client===hc&&epoch===connectionEpoch){busy=false;updateButtons();await refresh();}
 }
}
async function act(kind){`);
html = replaceOnce(html, "task_target:1,display_name:name", "task_target:2*Number(taskCount.value),display_name:name");
html = replaceOnce(html, `start.addEventListener('click',()=>void roundAction('start'));
task.addEventListener('click',()=>void roundAction('task'));`, "start.addEventListener('click',()=>void roundAction());");
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
