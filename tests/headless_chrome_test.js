/**
 * ヘッドレスChromeを用いたブラウザ実機環境でのエラー・レンダリング検証
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8089;
const ROOT = path.join(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png'
};

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';

  const filePath = path.join(ROOT, reqPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, async () => {
  console.log(`ローカルサーバー起動: http://localhost:${PORT}`);

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeArgs = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--dump-dom',
    `http://localhost:${PORT}/index.html`
  ];

  console.log('ヘッドレスChrome実行開始...');
  const child = spawn(chromePath, chromeArgs);

  let domOutput = '';
  let errOutput = '';

  child.stdout.on('data', (d) => { domOutput += d.toString(); });
  child.stderr.on('data', (d) => { errOutput += d.toString(); });

  child.on('close', (code) => {
    server.close();
    console.log(`Chrome終了コード: ${code}`);

    // DOM出力の確認
    const hasCodeArea = domOutput.includes('id="code-area"');
    const hasSecretScreen = domOutput.includes('id="secret-screen"');
    const hasCommitBtn = domOutput.includes('class="btn-commit"');

    console.log(`DOM要素チェック:`);
    console.log(`  code-area: ${hasCodeArea ? 'OK' : 'FAIL'}`);
    console.log(`  secret-screen: ${hasSecretScreen ? 'OK' : 'FAIL'}`);
    console.log(`  btn-commit: ${hasCommitBtn ? 'OK' : 'FAIL'}`);

    if (code === 0 && hasCodeArea && hasSecretScreen) {
      console.log('\n[PASS] ヘッドレスChromeレンダリング検証合格！');
      process.exit(0);
    } else {
      console.error('\n[FAIL] ヘッドレスChrome検証失敗');
      if (errOutput) console.error(errOutput);
      process.exit(1);
    }
  });
});
