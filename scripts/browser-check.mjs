// 无头浏览器验证：真实加载图形界面，操作控件并核对 DOM 与 WebGL 渲染。
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({
  executablePath: '/home/node/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux-arm64/chrome-headless-shell',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto('http://localhost:8080/', { waitUntil: 'networkidle' });
await page.waitForSelector('#tree details.node');
console.log('页面加载完成，无模块错误:', errors.length === 0);

// 1. S1 自动推进到结束
await page.click('#btnAuto');
await page.waitForFunction(() => document.querySelector('#banner')?.textContent?.includes('世界条件确认'),
  { timeout: 20000 }).catch(() => {});
await page.click('#btnAuto');
const banner = await page.textContent('#banner');
const stationLis = await page.$$eval('#results li', (els) => els.map((e) => e.textContent));
const leaves = await page.$$eval('#tree .leaf', (els) => els.length);
console.log('S1 横幅:', banner);
console.log('S1 世界条件:', stationLis.join(' | '));
console.log('S1 渲染叶子数:', leaves);

// 2. 切换 S2，核对方法适用性排除记录与轻量化方案
await page.selectOption('#scenarioSelect', 'lightTeam');
await page.waitForTimeout(300);
const trace = await page.textContent('#trace');
const method = await page.$eval('#tree .node .method', (e) => e.textContent);
console.log('S2 含排除记录:', trace.includes('排除'));
console.log('S2 选中方案:', method);

// 3. S4 局部换人：单步到退出时刻后继续，观察换人事件
await page.selectOption('#scenarioSelect', 'withdraw');
await page.selectOption('#recoveryMode', 'substitute');
for (let i = 0; i < 25; i++) await page.click('#btnStep');
const evText = await page.textContent('#events');
console.log('S4 出现局部换人:', evText.includes('substitute'));
console.log('S4 出现汇合安排:', evText.includes('汇合'));

// 4. S5 注入航测仪故障，核对失败阻止
await page.selectOption('#scenarioSelect', 'sharedDevice');
for (let i = 0; i < 4; i++) await page.click('#btnStep');
await page.click('#btnBreakDrone');
await page.waitForTimeout(200);
const ev2 = await page.textContent('#events');
console.log('S5 故障提示:', ev2.includes('航测仪D-1 损坏'));
console.log('S5 阻止后续动作:', ev2.includes('阻止'));

// 5. WebGL 画布确实渲染
const glPixels = await page.evaluate(() => {
  const c = document.querySelector('#view canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return { hasCanvas: !!c, w: c?.width, h: c?.height, gl: !!gl };
});
console.log('WebGL 画布:', JSON.stringify(glPixels));

console.log('\n浏览器错误:', errors.length ? errors.join('\n') : '无');
await page.screenshot({ path: '/tmp/ui-final.png', fullPage: false });
await browser.close();
process.exit(errors.length ? 1 : 0);
