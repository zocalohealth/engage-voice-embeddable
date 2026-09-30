const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '../build/rc');
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/diagnostic-test') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<script>
      window.widgetDiagnostics = [];
      addEventListener('message', event => {
        const data = event.data?.payload || event.data;
        if (data?.type === 'rc-ev-diagnostics') window.widgetDiagnostics.push(data.diagnostic);
      });
    </script><iframe src="app.html?clientId=local-smoke-test"></iframe>`);
    return;
  }
  const file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!file.startsWith(`${root}${path.sep}`)) { res.writeHead(403).end(); return; }
  try {
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      // This startup test performs no authentication or remote API requests.
      if (request.url().startsWith(`${origin}/`) || /^(data|blob):/.test(request.url())) void request.continue();
      else void request.abort();
    });
    await page.goto(`${origin}/diagnostic-test`);
    await page.waitForFunction(() => Reflect.get(window, 'widgetDiagnostics').some(event => event.event === 'widget_loaded'));
    const frame = page.frames().find(frame => frame.url().includes('/app.html'));
    assert.ok(frame);
    await frame.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('Sign In')));
    const diagnostic = await page.evaluate(() => Reflect.get(window, 'widgetDiagnostics').find(event => event.event === 'widget_loaded'));
    assert.equal(diagnostic.build.version, version);
    assert.equal(diagnostic.build.commit, process.env.BUILD_HASH || 'local');
    if (process.env.WIDGET_BUILD_AT) assert.equal(diagnostic.build.builtAt, process.env.WIDGET_BUILD_AT);
    assert.deepEqual(diagnostic.state.startBlockedBy, ['not_enabled', 'session_not_ready']);
    assert.deepEqual(errors, []);
    console.log('Widget startup passed: Sign In and loaded-build diagnostics verified.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
