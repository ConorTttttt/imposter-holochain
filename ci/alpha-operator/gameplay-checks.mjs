// Observe the actual desktop canvas draw calls without exposing game state
// through a production debugging API.
export const names = ['Map Host', 'Map Chrome', 'Map Firefox'];

export async function prepareMovement(browser, name) {
  await browser.evaluate(name => {
    const input = document.getElementById('player-name');
    input.value = name;
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
}
