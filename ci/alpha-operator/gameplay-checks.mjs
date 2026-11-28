// Observe the actual desktop canvas draw calls without exposing game state
// through a production debugging API.
export const names = ['Map Host', 'Map Chrome', 'Map Firefox'];

export async function prepareMovement(browser, name) {
  await browser.evaluate(name => {
    const input = document.getElementById('player-name');
    input.value = name;
    const taskCount = document.getElementById('task-count');
    if (taskCount) taskCount.value = '1';
    if (window.gameplayObservedPoints) return;
    const points = {};
    window.gameplayObservedPoints = points;
    const prototype = CanvasRenderingContext2D.prototype;
    const fillText = prototype.fillText;
    const clearRect = prototype.clearRect;
    prototype.clearRect = function (...args) {
      if (this.canvas.closest('#gameplay-map')) {
        for (const key of Object.keys(points)) delete points[key];
      }
      return clearRect.apply(this, args);
    };
    prototype.fillText = function (label, x, y, ...args) {
      if (this.canvas.closest('#gameplay-map') && /^Map (Host|Chrome|Firefox)$/.test(label)) {
        points[label] = [x, y];
        window.gameplayCameraX = this.getTransform().e;
      }
      return fillText.call(this, label, x, y, ...args);
    };
  }, name);
}

function positions(browser) {
  return browser.evaluate(() => {
    const map = document.getElementById('gameplay-map');
    const status = document.getElementById('movement-status');
    return !map.hidden && status.textContent === 'Movement connected' && window.gameplayObservedPoints;
  });
}

export async function checkMovement(browsers, until) {
  const views = () => Promise.all(browsers.map(browser => positions(browser)));
  const before = await until(async () => {
    const rows = await views();
    return rows.every(row => row && names.every(name => row[name]) &&
      new Set(names.map(name => row[name].join(','))).size === names.length) && rows;
  }, 35000);

  await Promise.all(browsers.map(async browser => {
    await browser.evaluate(() => document.querySelector('#gameplay-map canvas').focus());
    await browser.holdKey('s', 325);
  }));
  await until(async () => {
    const rows = await views();
    return rows.every((row, index) => row && names.every(name =>
      row[name]?.[1] > before[index][name][1] + 14 && Math.abs(row[name][0] - before[index][name][0]) < 1));
  }, 15000);
  const host = browsers[0];
  const camera = await host.evaluate(() => window.gameplayCameraX);
  await host.holdKey('d', 250);
  await until(async () => (await host.evaluate(() => window.gameplayCameraX)) < camera - 5);
  await host.holdKey('w', 1700);
  const wall = (await positions(host))[names[0]][1] + 27.5;
  if (wall < 70 || wall > 77) throw Error('Player did not stop at the bridge wall');
  await host.holdKey('w', 300);
  await until(async () => Math.abs((await positions(host))[names[0]][1] + 27.5 - wall) < 1);
}

async function walk(browser, name, until, waypoints) {
  await browser.evaluate(() => document.querySelector('#gameplay-map canvas').focus());
  const local = async () => {
    const pos = (await positions(browser))?.[name];
    // The observed name baseline is 27.5 map pixels above the player centre.
    if (pos) return [pos[0], pos[1] + 27.5];
  };
  for (const [axis, target] of waypoints) {
    await until(async () => {
      const point = await local();
      if (!point) return false;
      const remaining = target - point[axis];
      if (Math.abs(remaining) <= 8) return true;
      const key = axis === 0 ? (remaining > 0 ? 'd' : 'a') : (remaining > 0 ? 's' : 'w');
      await browser.holdKey(key, Math.max(35, Math.min(1400, Math.round(Math.abs(remaining) * (1000 / 192)))));
      return false;
    }, 12000);
  }
}

export async function callEmergencyMeeting(browser, name, until) {
  await walk(browser, name, until, [[0, 1200], [1, 465], [0, 1240], [1, 885], [0, 1200]]);
  await until(() => browser.evaluate(() => {
    const button = document.getElementById('call-emergency');
    if (button.disabled) return false;
    button.click();
    return true;
  }));
}

export async function checkChat(browsers, until, scope) {
  await Promise.all(browsers.map(browser => until(() => browser.evaluate(() => {
    const chat = document.getElementById('browser-chat');
    return !chat.hidden && !chat.querySelector('input').disabled;
  }), 15000)));
  const send = (browser, text) => browser.evaluate(text => {
    const form = document.querySelector('#browser-chat form');
    form.querySelector('input').value = text;
    form.requestSubmit();
  }, text);
  const fromFirefox = scope + ' from Firefox <b>literal text</b>';
  const fromChromium = scope + ' from Chromium';
  await send(browsers[2], fromFirefox);
  await send(browsers[0], fromChromium);
  await Promise.all(browsers.map(browser => until(() => browser.evaluate(({fromFirefox, fromChromium}) => {
    const log = document.getElementById('browser-chat-log');
    return log.textContent.includes(fromFirefox) && log.textContent.includes(fromChromium) && !log.querySelector('b');
  }, {fromFirefox, fromChromium}), 15000)));
}

export async function completeEngineTask(browser, name, until) {
  await walk(browser, name, until, [
    [0, 1200], [1, 465], [0, 1240], [1, 900], [0, 1060], [1, 1250],
    [0, 1120], [1, 1420], [0, 1280], [1, 1555], [0, 1245],
  ]);
  await until(() => browser.evaluate(() => !document.getElementById('use-console').disabled));
  await browser.holdKey('e', 50);
  await until(() => browser.evaluate(() => {
    const dialog = document.getElementById('console-game');
    return dialog.open && dialog.querySelector('h3').textContent === 'Align Engine Output';
  }));
  const completed = await browser.evaluate(() => {
    const slider = document.getElementById('mg-slider');
    const marker = document.querySelector('#console-game .mg-target');
    const lock = document.querySelector('#console-game [data-mg="lock"]');
    if (!slider || !marker || !lock) return false;
    slider.value = parseFloat(marker.style.left);
    slider.dispatchEvent(new Event('input', {bubbles:true}));
    lock.click();
    return true;
  });
  if (!completed) throw Error('The engine mini-game could not be completed');
}
