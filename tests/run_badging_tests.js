/**
 * App Badging API & Service Worker 単体・モック動作検証テスト
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passedTests = 0;
let failedTests = 0;

function assertJsonEqual(actual, expected, msg) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), msg);
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    failedTests++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    failedTests++;
  }
}

async function main() {
  console.log('====================================================');
  console.log('App Badging API & Service Worker 自動検証テスト開始');
  console.log('====================================================\n');

  // ----------------------------------------------------
  // テスト群 1: フォアグラウンド バッジ動作 (updateBadge)
  // ----------------------------------------------------
  console.log('--- テスト 1: フォアグラウンド バッジ動作 (updateBadge) ---');

  function createAppContext(options = {}) {
    const badgingSupported = options.badgingSupported !== false;
    const badgingRejects = options.badgingRejects === true;
    const swSupported = options.swSupported !== false;

    const calls = {
      setAppBadge: [],
      clearAppBadge: [],
      postMessage: []
    };

    const fakeDocument = {
      title: 'EditCode / index.html',
      getElementById: (id) => {
        if (id === 'unread-badge') return { innerText: '', classList: { add: () => {}, remove: () => {} } };
        return null;
      },
      querySelector: (sel) => {
        if (sel === '.btn-commit') return { innerText: '', classList: { toggle: () => {} } };
        return null;
      }
    };

    const fakeNavigator = {};

    if (badgingSupported) {
      fakeNavigator.setAppBadge = (count) => {
        calls.setAppBadge.push(count);
        if (badgingRejects) return Promise.reject(new Error('Set badge rejected'));
        return Promise.resolve();
      };
      fakeNavigator.clearAppBadge = () => {
        calls.clearAppBadge.push(true);
        if (badgingRejects) return Promise.reject(new Error('Clear badge rejected'));
        return Promise.resolve();
      };
    }

    if (swSupported) {
      fakeNavigator.serviceWorker = {
        controller: {
          postMessage: (msg) => {
            calls.postMessage.push(msg);
          }
        }
      };
    }

    const appJsCode = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

    const sandbox = {
      document: fakeDocument,
      navigator: fakeNavigator,
      console: {
        log: () => {},
        warn: () => {},
        error: () => {}
      },
      Math: Math,
      Number: Number,
      calls: calls
    };

    const script = new vm.Script(`
      ${appJsCode.substring(
        appJsCode.indexOf('function updateBadge(count) {'),
        appJsCode.indexOf('function toggleStampPalette() {')
      )}
    `);

    const context = vm.createContext(sandbox);
    script.runInContext(context);

    return { context, calls, sandbox };
  }

  runTest('1-1. updateBadge(3): setAppBadge(3), postMessage(SYNC_BADGE), タイトル更新', () => {
    const { context, calls, sandbox } = createAppContext();
    context.updateBadge(3);

    assert.strictEqual(calls.setAppBadge.length, 1, 'setAppBadge が1回呼ばれること');
    assert.strictEqual(calls.setAppBadge[0], 3, 'setAppBadge の引数が 3 であること');
    assert.strictEqual(calls.postMessage.length, 1, 'SW postMessage が1回呼ばれること');
    assertJsonEqual(calls.postMessage[0], { type: 'SYNC_BADGE', count: 3 });
    assert.strictEqual(sandbox.document.title, '(3) EditCode / index.html', 'ドキュメントタイトルが更新されること');
  });

  runTest('1-2. updateBadge(0): clearAppBadge(), postMessage(CLEAR_BADGE), タイトル復元', () => {
    const { context, calls, sandbox } = createAppContext();
    sandbox.document.title = '(3) EditCode / index.html';
    context.updateBadge(0);

    assert.strictEqual(calls.clearAppBadge.length, 1, 'clearAppBadge が1回呼ばれること');
    assert.strictEqual(calls.postMessage.length, 1, 'SW postMessage が1回呼ばれること');
    assertJsonEqual(calls.postMessage[0], { type: 'CLEAR_BADGE' });
    assert.strictEqual(sandbox.document.title, 'EditCode / index.html', 'ドキュメントタイトルが復元されること');
  });

  runTest('1-3. Badging API 非対応環境: setAppBadge/clearAppBadge なしでも例外が出ずタイトル更新・SW通知が動作', () => {
    const { context, calls, sandbox } = createAppContext({ badgingSupported: false });
    
    context.updateBadge(5);
    assert.strictEqual(sandbox.document.title, '(5) EditCode / index.html');
    assertJsonEqual(calls.postMessage[0], { type: 'SYNC_BADGE', count: 5 });

    context.updateBadge(0);
    assert.strictEqual(sandbox.document.title, 'EditCode / index.html');
    assertJsonEqual(calls.postMessage[1], { type: 'CLEAR_BADGE' });
  });

  runTest('1-4. Badging API 例外環境: Promise reject でもエラーがスローされず処理が完遂すること', () => {
    const { context, calls, sandbox } = createAppContext({ badgingRejects: true });
    context.updateBadge(2);
    assert.strictEqual(sandbox.document.title, '(2) EditCode / index.html');

    context.updateBadge(0);
    assert.strictEqual(sandbox.document.title, 'EditCode / index.html');
  });

  runTest('1-5. 境界値・不正入力値: 負数・小数・NaN・文字列等の安全処理', () => {
    const { context, calls, sandbox } = createAppContext();

    context.updateBadge(-1);
    assert.strictEqual(sandbox.document.title, 'EditCode / index.html', '負数は0扱い');

    context.updateBadge(4.7);
    assert.strictEqual(sandbox.document.title, '(4) EditCode / index.html', '小数は切り捨て整数');
    assert.strictEqual(calls.setAppBadge[0], 4);

    context.updateBadge('invalid');
    assert.strictEqual(sandbox.document.title, 'EditCode / index.html', '非数値は0扱い');

    context.updateBadge(null);
    assert.strictEqual(sandbox.document.title, 'EditCode / index.html', 'nullは0扱い');
  });

  // ----------------------------------------------------
  // テスト群 2: Service Worker バッジ動作 (sw.js)
  // ----------------------------------------------------
  console.log('\n--- テスト 2: Service Worker バッジ動作 (sw.js) ---');

  function createSwContext(options = {}) {
    const badgingSupported = options.badgingSupported !== false;
    const badgingRejects = options.badgingRejects === true;

    const calls = {
      setAppBadge: [],
      clearAppBadge: [],
      showNotification: [],
      waitUntil: []
    };

    const listeners = {};

    const fakeSelf = {
      addEventListener: (type, listener) => {
        listeners[type] = listener;
      },
      skipWaiting: () => {},
      clients: {
        claim: () => {},
        matchAll: async () => []
      },
      registration: {
        showNotification: async (title, opt) => {
          calls.showNotification.push({ title, opt });
        }
      }
    };

    if (badgingSupported) {
      fakeSelf.registration.setAppBadge = (count) => {
        calls.setAppBadge.push(count);
        if (badgingRejects) return Promise.reject(new Error('SW setAppBadge failed'));
        return Promise.resolve();
      };
      fakeSelf.registration.clearAppBadge = () => {
        calls.clearAppBadge.push(true);
        if (badgingRejects) return Promise.reject(new Error('SW clearAppBadge failed'));
        return Promise.resolve();
      };
    }

    const fakeCaches = {
      open: async () => ({
        add: async () => {},
        addAll: async () => {},
        put: async () => {}
      }),
      keys: async () => [],
      delete: async () => {}
    };

    const swJsCode = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');

    const sandbox = {
      self: fakeSelf,
      caches: fakeCaches,
      clients: fakeSelf.clients,
      console: {
        log: () => {},
        warn: () => {},
        error: () => {}
      },
      Promise: Promise,
      Date: Date,
      JSON: JSON
    };

    const context = vm.createContext(sandbox);
    const script = new vm.Script(swJsCode);
    script.runInContext(context);

    return { context, listeners, calls };
  }

  await runAsyncTest('2-1. push イベント: ペイロード badgeCount: 5 が self.registration.setAppBadge(5) に渡されること', async () => {
    const { listeners, calls } = createSwContext();
    assert.ok(listeners['push'], 'push リスナーが存在すること');

    let waitUntilPromise = null;
    const event = {
      data: {
        json: () => ({
          title: '新着メッセージ',
          body: 'テストメッセージ',
          badgeCount: 5
        })
      },
      waitUntil: (p) => {
        waitUntilPromise = p;
      }
    };

    listeners['push'](event);
    assert.ok(waitUntilPromise, 'event.waitUntil が呼ばれること');
    await waitUntilPromise;

    assert.strictEqual(calls.setAppBadge.length, 1);
    assert.strictEqual(calls.setAppBadge[0], 5, 'badgeCount 5 が setAppBadge に渡されること');
    assert.strictEqual(calls.showNotification.length, 1);
  });

  await runAsyncTest('2-2. push イベント: badgeCount 未指定時はデフォルトで 1 が渡されること', async () => {
    const { listeners, calls } = createSwContext();

    let waitUntilPromise = null;
    const event = {
      data: {
        json: () => ({
          title: '通知',
          body: 'badgeCountなし'
        })
      },
      waitUntil: (p) => {
        waitUntilPromise = p;
      }
    };

    listeners['push'](event);
    await waitUntilPromise;

    assert.strictEqual(calls.setAppBadge.length, 1);
    assert.strictEqual(calls.setAppBadge[0], 1, 'badgeCount デフォルト 1 が渡されること');
  });

  await runAsyncTest('2-3. notificationclick イベント: self.registration.clearAppBadge() が呼ばれること', async () => {
    const { listeners, calls } = createSwContext();
    assert.ok(listeners['notificationclick'], 'notificationclick リスナーが存在すること');

    let closed = false;
    let waitUntilPromise = null;
    const event = {
      notification: {
        close: () => { closed = true; }
      },
      waitUntil: (p) => {
        waitUntilPromise = p;
      }
    };

    listeners['notificationclick'](event);
    assert.strictEqual(closed, true, 'notification.close() が呼ばれること');
    await waitUntilPromise;

    assert.strictEqual(calls.clearAppBadge.length, 1, 'clearAppBadge が呼ばれること');
  });

  await runAsyncTest('2-4. message イベント: CLEAR_BADGE で clearAppBadge() が呼ばれること', async () => {
    const { listeners, calls } = createSwContext();
    assert.ok(listeners['message'], 'message リスナーが存在すること');

    let waitUntilPromise = null;
    const event = {
      data: { type: 'CLEAR_BADGE' },
      waitUntil: (p) => {
        waitUntilPromise = p;
      }
    };

    listeners['message'](event);
    if (waitUntilPromise) await waitUntilPromise;

    assert.strictEqual(calls.clearAppBadge.length, 1, 'CLEAR_BADGE受信でclearAppBadgeが呼ばれること');
  });

  await runAsyncTest('2-5. message イベント: SYNC_BADGE(count: 7) で setAppBadge(7) が呼ばれること', async () => {
    const { listeners, calls } = createSwContext();

    let waitUntilPromise = null;
    const event = {
      data: { type: 'SYNC_BADGE', count: 7 },
      waitUntil: (p) => {
        waitUntilPromise = p;
      }
    };

    listeners['message'](event);
    if (waitUntilPromise) await waitUntilPromise;

    assert.strictEqual(calls.setAppBadge.length, 1);
    assert.strictEqual(calls.setAppBadge[0], 7, 'SYNC_BADGE受信でsetAppBadge(7)が呼ばれること');
  });

  await runAsyncTest('2-6. message イベント: SYNC_BADGE(count: 0) で clearAppBadge() が呼ばれること', async () => {
    const { listeners, calls } = createSwContext();

    let waitUntilPromise = null;
    const event = {
      data: { type: 'SYNC_BADGE', count: 0 },
      waitUntil: (p) => {
        waitUntilPromise = p;
      }
    };

    listeners['message'](event);
    if (waitUntilPromise) await waitUntilPromise;

    assert.strictEqual(calls.clearAppBadge.length, 1, 'SYNC_BADGE(0)受信でclearAppBadgeが呼ばれること');
  });

  await runAsyncTest('2-7. SW setAppBadge / clearAppBadge 非対応・エラー時の耐障害性', async () => {
    const { listeners } = createSwContext({ badgingSupported: false });
    let p1, p2, p3;

    listeners['push']({
      data: { json: () => ({ title: 'T', body: 'B', badgeCount: 2 }) },
      waitUntil: (p) => { p1 = p; }
    });
    if (p1) await p1;

    listeners['notificationclick']({
      notification: { close: () => {} },
      waitUntil: (p) => { p2 = p; }
    });
    if (p2) await p2;

    listeners['message']({
      data: { type: 'SYNC_BADGE', count: 2 },
      waitUntil: (p) => { p3 = p; }
    });
    if (p3) await p3;

    assert.ok(true, '例外なく完了');
  });

  // ----------------------------------------------------
  // テスト群 3: Push送信ペイロード (triggerPushNotification)
  // ----------------------------------------------------
  console.log('\n--- テスト 3: Push送信ペイロード (triggerPushNotification) ---');

  function createPushContext() {
    const fetchCalls = [];

    const fakeFetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true })
      };
    };

    const pushJsCode = fs.readFileSync(path.join(__dirname, '../js/push.js'), 'utf8');

    const sandbox = {
      fetch: fakeFetch,
      VERCEL_API_URL: 'https://example-push.vercel.app/api/send-push',
      targetRole: 'editor_bob',
      myRole: 'editor_alice',
      GITHUB_CONFIG: {
        owner: 'test',
        repo: 'repo',
        getToken: () => 'token123'
      },
      localStorage: {
        getItem: (key) => {
          if (key === 'push_subscription_editor_bob') {
            return JSON.stringify({ endpoint: 'https://push.example.com/sub/123' });
          }
          if (key === 'chat_history') {
            return JSON.stringify([
              { id: '1', sender: 'partner', isRead: false },
              { id: '2', sender: 'partner', isRead: false }
            ]);
          }
          return null;
        },
        setItem: () => {},
        removeItem: () => {}
      },
      console: {
        log: () => {},
        warn: () => {},
        error: () => {}
      },
      alert: () => {},
      Math: Math,
      Date: Date,
      JSON: JSON
    };

    const context = vm.createContext(sandbox);
    const script = new vm.Script(`
      ${pushJsCode}
    `);
    script.runInContext(context);

    return { context, fetchCalls, sandbox };
  }

  await runAsyncTest('3-1. triggerPushNotification: badgeCount が指定されたとき、ペイロードに反映されること', async () => {
    const { context, fetchCalls } = createPushContext();

    const success = await context.triggerPushNotification(
      '通知タイトル',
      'メッセージ本文',
      true, // silent
      4     // badgeCount
    );

    assert.strictEqual(success, true);
    assert.ok(fetchCalls.length >= 1);
    const pushCall = fetchCalls[fetchCalls.length - 1];
    assert.strictEqual(pushCall.url, 'https://example-push.vercel.app/api/send-push');

    const payload = JSON.parse(pushCall.options.body);
    assert.strictEqual(payload.title, '通知タイトル');
    assert.strictEqual(payload.body, 'メッセージ本文');
    assert.strictEqual(payload.badgeCount, 4, 'payload.badgeCount が 4 であること');
  });

  await runAsyncTest('3-2. triggerPushNotification: badgeCount 未指定時、getLocalUnreadCount() + 1 が計算されること', async () => {
    const { context, fetchCalls } = createPushContext();

    const success = await context.triggerPushNotification(
      '通知タイトル',
      'メッセージ本文',
      true // silent
    );

    assert.strictEqual(success, true);
    const pushCall = fetchCalls[fetchCalls.length - 1];
    const payload = JSON.parse(pushCall.options.body);
    assert.strictEqual(payload.badgeCount, 3, 'payload.badgeCount が 3 (未読2 + 1) であること');
  });

  // ----------------------------------------------------
  // テスト群 4: 未読ライフサイクル連携テスト
  // ----------------------------------------------------
  console.log('\n--- テスト 4: 未読ライフサイクル連携テスト ---');

  function createFullAppContext() {
    const calls = {
      setAppBadge: [],
      clearAppBadge: [],
      postMessage: [],
      renderedMessages: []
    };

    let storedChat = [];

    const fakeDocument = {
      title: 'EditCode / index.html',
      getElementById: (id) => {
        return {
          innerText: '',
          classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
          style: {},
          value: '',
          focus: () => {},
          setSelectionRange: () => {},
          setAttribute: () => {},
          addEventListener: () => {},
          remove: () => {}
        };
      },
      querySelector: (sel) => {
        return {
          innerText: '',
          classList: { toggle: () => {}, add: () => {}, remove: () => {} },
          closest: () => ({ remove: () => {} })
        };
      },
      addEventListener: () => {}
    };

    const fakeNavigator = {
      setAppBadge: (c) => {
        calls.setAppBadge.push(c);
        return Promise.resolve();
      },
      clearAppBadge: () => {
        calls.clearAppBadge.push(true);
        return Promise.resolve();
      },
      serviceWorker: {
        controller: {
          postMessage: (m) => calls.postMessage.push(m)
        }
      }
    };

    const fakeLocalStorage = {
      getItem: (k) => {
        if (k === 'chat_history') return JSON.stringify(storedChat);
        return null;
      },
      setItem: (k, v) => {
        if (k === 'chat_history') storedChat = JSON.parse(v);
      },
      removeItem: (k) => {
        if (k === 'chat_history') storedChat = [];
      }
    };

    const sandbox = {
      document: fakeDocument,
      navigator: fakeNavigator,
      localStorage: fakeLocalStorage,
      sessionStorage: { getItem: () => null, setItem: () => {} },
      window: {
        addEventListener: () => {},
        localStorage: fakeLocalStorage
      },
      console: { log: () => {}, warn: () => {}, error: () => {} },
      Math: Math,
      Date: Date,
      Number: Number,
      JSON: JSON,
      calls: calls,
      getStoredMessages: () => storedChat,
      saveStoredMessages: (msgs) => { storedChat = msgs; return msgs; },
      renderAllMessages: () => { calls.renderedMessages.push([...storedChat]); },
      scrollMessageListToBottom: () => {},
      activeConn: null,
      myRole: 'alice',
      targetRole: 'bob'
    };

    const appJsCode = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

    const context = vm.createContext(sandbox);

    const script = new vm.Script(`
      ${appJsCode.substring(
        appJsCode.indexOf('function clearPartnerUnreadState() {'),
        appJsCode.indexOf('function toggleMessageVisibility() {')
      )}

      ${appJsCode.substring(
        appJsCode.indexOf('function saveAndRenderNewMessage(msgObj) {'),
        appJsCode.indexOf('function renderSingleMessage(m) {')
      )}

      ${appJsCode.substring(
        appJsCode.indexOf('function deleteLocalMessage(msgId) {'),
        appJsCode.indexOf('function toggleStampPalette() {')
      )}
    `);

    script.runInContext(context);

    return { context, calls, sandbox, getStoredChat: () => storedChat, setStoredChat: (c) => { storedChat = c; } };
  }

  runTest('4-1. saveAndRenderNewMessage: 新規partnerメッセージ受信 ➔ 未読数1 ➔ setAppBadge(1)', () => {
    const { context, calls, sandbox } = createFullAppContext();

    const newMsg = {
      id: 'msg-001',
      text: 'こんにちは',
      sender: 'partner',
      isRead: false,
      timestamp: Date.now()
    };

    context.saveAndRenderNewMessage(newMsg);

    assert.strictEqual(calls.setAppBadge.length, 1);
    assert.strictEqual(calls.setAppBadge[0], 1, '未読数1でsetAppBadgeが呼ばれること');
    assert.strictEqual(sandbox.document.title, '(1) EditCode / index.html');
    assertJsonEqual(calls.postMessage[0], { type: 'SYNC_BADGE', count: 1 });
  });

  runTest('4-2. saveAndRenderNewMessage: 2通目受信 ➔ 未読数2 ➔ setAppBadge(2)', () => {
    const { context, calls, sandbox } = createFullAppContext();

    context.saveAndRenderNewMessage({ id: 'msg-001', text: '1通目', sender: 'partner', isRead: false });
    context.saveAndRenderNewMessage({ id: 'msg-002', text: '2通目', sender: 'partner', isRead: false });

    assert.strictEqual(calls.setAppBadge.length, 2);
    assert.strictEqual(calls.setAppBadge[1], 2, '未読数2でsetAppBadgeが呼ばれること');
    assert.strictEqual(sandbox.document.title, '(2) EditCode / index.html');
  });

  runTest('4-3. clearPartnerUnreadState: メッセージ既読化 ➔ 未読数0 ➔ clearAppBadge()', () => {
    const { context, calls, sandbox } = createFullAppContext();

    context.saveAndRenderNewMessage({ id: 'msg-001', text: '未読メッセージ', sender: 'partner', isRead: false });
    assert.strictEqual(calls.setAppBadge[0], 1);

    context.clearPartnerUnreadState();

    assert.strictEqual(calls.clearAppBadge.length, 1, 'clearAppBadgeが呼ばれること');
    assert.strictEqual(sandbox.document.title, 'EditCode / index.html', 'タイトルが復元されること');
    assertJsonEqual(calls.postMessage[1], { type: 'CLEAR_BADGE' });
  });

  runTest('4-4. deleteLocalMessage: 2件中1件削除 ➔ 未読数1 ➔ setAppBadge(1)', () => {
    const { context, calls, sandbox } = createFullAppContext();

    context.saveAndRenderNewMessage({ id: 'msg-001', text: '1通目', sender: 'partner', isRead: false });
    context.saveAndRenderNewMessage({ id: 'msg-002', text: '2通目', sender: 'partner', isRead: false });
    assert.strictEqual(calls.setAppBadge.length, 2);

    context.deleteLocalMessage('msg-001');

    assert.strictEqual(calls.setAppBadge.length, 3);
    assert.strictEqual(calls.setAppBadge[2], 1, '削除後に未読数1でsetAppBadgeが呼ばれること');
    assert.strictEqual(sandbox.document.title, '(1) EditCode / index.html');
  });

  runTest('4-5. deleteLocalMessage: 残り1件削除 ➔ 未読数0 ➔ clearAppBadge()', () => {
    const { context, calls, sandbox } = createFullAppContext();

    context.saveAndRenderNewMessage({ id: 'msg-001', text: '1通目', sender: 'partner', isRead: false });
    context.deleteLocalMessage('msg-001');

    assert.strictEqual(calls.clearAppBadge.length, 1, '全未読削除でclearAppBadgeが呼ばれること');
    assert.strictEqual(sandbox.document.title, 'EditCode / index.html');
  });

  runTest('4-6. visibilitychange: 画面復帰時の未読再同期 ➔ updateBadge()', () => {
    const { context, calls, sandbox } = createFullAppContext();

    context.saveAndRenderNewMessage({ id: 'msg-001', text: '1通目', sender: 'partner', isRead: false });
    const callsBefore = calls.setAppBadge.length;

    context.updateUnreadBadgeCount();

    assert.strictEqual(calls.setAppBadge.length, callsBefore + 1, '画面復帰時にupdateUnreadBadgeCountでバッジ再同期');
    assert.strictEqual(calls.setAppBadge[calls.setAppBadge.length - 1], 1);
  });

  // ----------------------------------------------------
  // テスト群 5: HTML / CSS / 資産ファイル整合性検証
  // ----------------------------------------------------
  console.log('\n--- テスト 5: HTML / CSS / 資産ファイル整合性検証 ---');

  runTest('5-1. sw.js の ASSETS リストに含まれるファイルが実在すること', () => {
    const swCode = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
    const match = swCode.match(/const ASSETS = \[\s*([\s\S]*?)\s*\];/);
    assert.ok(match, 'ASSETS 配列が見つかること');

    const assetPaths = match[1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(s => s.length > 0);

    for (const asset of assetPaths) {
      if (asset === './') continue;
      const resolvedPath = path.join(__dirname, '..', asset.replace(/^\.\//, ''));
      assert.ok(fs.existsSync(resolvedPath), `資産ファイル ${asset} が存在すること (${resolvedPath})`);
    }
  });

  runTest('5-2. index.html に script タグとして必要なスクリプトが正しく読み込まれていること', () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

    assert.ok(html.includes('src="js/config.js"'), 'js/config.js が読み込まれていること');
    assert.ok(html.includes('src="js/push.js"'), 'js/push.js が読み込まれていること');
    assert.ok(html.includes('src="js/github.js"'), 'js/github.js が読み込まれていること');
    assert.ok(html.includes('src="js/app.js"'), 'js/app.js が読み込まれていること');
  });

  runTest('5-3. manifest.json の構文チェック & アイコン設定', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
    assert.ok(manifest.name, 'manifest に name が存在すること');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'icons 配列が存在すること');
  });

  // ----------------------------------------------------
  // テスト実行サマリー
  // ----------------------------------------------------
  console.log('\n====================================================');
  console.log(`検証完了: 全 ${passedTests + failedTests} テスト中 ${passedTests} 合格, ${failedTests} 失敗`);
  console.log('====================================================');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('予期せぬエラー:', err);
  process.exit(1);
});
