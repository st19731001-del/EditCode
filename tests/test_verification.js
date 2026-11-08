/**
 * test_verification.js
 * 通話時誤タッチ防止（耳あて消灯・タッチガード）および通常通話モード音響改善の検証スクリプト
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passedTests = 0;
let totalTests = 0;

function it(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

async function itAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// モック環境の構築
// -----------------------------------------------------------------------------
class MockAudioParam {
  constructor(initialVal = 0) {
    this.value = initialVal;
    this.target = initialVal;
    this.timeConstant = 0;
    this.scheduled = [];
  }
  setTargetAtTime(target, startTime, timeConstant) {
    this.target = target;
    this.value = target;
    this.timeConstant = timeConstant;
    this.scheduled.push({ type: 'setTargetAtTime', target, startTime, timeConstant });
  }
  cancelScheduledValues(startTime) {
    this.scheduled.push({ type: 'cancelScheduledValues', startTime });
  }
}

class MockGainNode {
  constructor() {
    this.gain = new MockAudioParam(1.0);
    this.connectedTo = null;
  }
  connect(dest) { this.connectedTo = dest; }
  disconnect() { this.connectedTo = null; }
}

class MockBiquadFilterNode {
  constructor() {
    this.type = 'lowpass';
    this.frequency = new MockAudioParam(350);
    this.Q = new MockAudioParam(1);
    this.connectedTo = null;
  }
  connect(dest) { this.connectedTo = dest; }
  disconnect() { this.connectedTo = null; }
}

class MockMediaStreamSource {
  constructor(stream) {
    this.stream = stream;
    this.connectedTo = null;
  }
  connect(dest) { this.connectedTo = dest; }
  disconnect() { this.connectedTo = null; }
}

class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 10.0;
    this.destination = { type: 'destination' };
  }
  createGain() { return new MockGainNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createMediaStreamSource(stream) { return new MockMediaStreamSource(stream); }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}

class MockAudioElement {
  constructor() {
    this.srcObject = null;
    this.muted = false;
    this.volume = 1.0;
    this.sinkId = '';
    this.played = false;
  }
  async play() { this.played = true; }
  async setSinkId(id) { this.sinkId = id; }
}

class MockDOMElement {
  constructor(id = '', tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.classList = new Set();
    this.innerText = '';
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.children = [];
  }
  addEventListener(event, handler, options) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }
  removeEventListener(event, handler) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(h => h !== handler);
  }
  dispatchEvent(eventObj) {
    const handlers = this.listeners[eventObj.type] || [];
    for (const h of handlers) {
      h(eventObj);
    }
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  appendChild(child) { this.children.push(child); }
}

// Set用のヘルパー
Set.prototype.addOld = Set.prototype.add;
MockDOMElement.prototype.classList = null;

function createMockElement(id, tag = 'div') {
  const el = new MockDOMElement(id, tag);
  const classListSet = new Set();
  el.classList = {
    add: (c) => classListSet.add(c),
    remove: (c) => classListSet.delete(c),
    toggle: (c) => classListSet.has(c) ? classListSet.delete(c) : classListSet.add(c),
    contains: (c) => classListSet.has(c)
  };
  return el;
}

// global ブラウザ環境モック
const domRegistry = {};
function getOrCreateElement(id) {
  if (!domRegistry[id]) {
    domRegistry[id] = createMockElement(id);
  }
  return domRegistry[id];
}

global.window = {
  AudioContext: MockAudioContext,
  webkitAudioContext: MockAudioContext,
  DeviceOrientationEvent: function() {},
  isSecureContext: true
};

const windowListeners = {};
global.window.addEventListener = (event, handler) => {
  if (!windowListeners[event]) windowListeners[event] = [];
  windowListeners[event].push(handler);
};
global.window.dispatchEvent = (eventObj) => {
  const handlers = windowListeners[eventObj.type] || [];
  for (const h of handlers) {
    h(eventObj);
  }
};

global.document = {
  readyState: 'complete',
  getElementById: (id) => getOrCreateElement(id),
  querySelector: (sel) => null,
  createElement: (tag) => createMockElement('', tag),
  body: createMockElement('body', 'body'),
  addEventListener: () => {}
};

const localStorageStore = {};
global.localStorage = {
  getItem: (k) => (k in localStorageStore ? localStorageStore[k] : null),
  setItem: (k, v) => { localStorageStore[k] = String(v); },
  removeItem: (k) => { delete localStorageStore[k]; },
  clear: () => { for (const k of Object.keys(localStorageStore)) delete localStorageStore[k]; }
};

const mockNavigator = {
  vibrate: (pattern) => true,
  mediaDevices: {
    enumerateDevices: async () => [
      { kind: 'audiooutput', deviceId: 'dev-earpiece', label: 'Earpiece Receiver' },
      { kind: 'audiooutput', deviceId: 'dev-speaker', label: 'Speaker' },
      { kind: 'audioinput', deviceId: 'dev-mic', label: 'Microphone' }
    ]
  }
};
Object.defineProperty(global, 'navigator', {
  value: mockNavigator,
  writable: true,
  configurable: true
});

global.activeCall = null;
global.targetRole = 'user_b';
global.myRole = 'user_a';

const vm = require('vm');

// -----------------------------------------------------------------------------
// js/app.js から CallAudioManager と TouchGuardManager を抽出してロード
// -----------------------------------------------------------------------------
const appJsPath = path.resolve(__dirname, 'js/app.js');
const appJsCode = fs.readFileSync(appJsPath, 'utf8');

// CallAudioManager と TouchGuardManager クラスおよび補助関数をロード
const targetSnippet = appJsCode.slice(
  appJsCode.indexOf('class CallAudioManager'),
  appJsCode.indexOf('// 通話・画面制御')
);

vm.runInThisContext(targetSnippet);

// -----------------------------------------------------------------------------
// テストスイートの実行
// -----------------------------------------------------------------------------
async function runTests() {
  console.log('=== テストスイート 1: 音量・音響プロファイル改善検証 (CallAudioManager) ===');

  it('1-1. 初期モードの復元とデフォルト設定', () => {
    localStorage.removeItem('preferred_call_mode');
    const cam = new CallAudioManager();
    assert.strictEqual(cam.getMode(), 'normal', 'デフォルトは通常通話 (normal) であること');

    localStorage.setItem('preferred_call_mode', 'speaker');
    const camSpeaker = new CallAudioManager();
    assert.strictEqual(camSpeaker.getMode(), 'speaker', '保存値 speaker が復元されること');
  });

  await itAsync('1-2. 通常通話モード (normal) における音響パラメータ検証', async () => {
    const cam = new CallAudioManager();
    const audioElem = new MockAudioElement();
    const fakeStream = { id: 'stream-1' };

    await cam.attachRemoteStream(audioElem, fakeStream);
    cam.setMode('normal');

    // ゲイン検証: 1.0 であること（以前の 0.38 ではないこと）
    assert.strictEqual(cam.gainNode.gain.target, 1.0, 'GainNode の目標ゲイン値が 1.0 であること');
    assert.notStrictEqual(cam.gainNode.gain.target, 0.38, '旧ゲイン値 0.38 ではないこと');

    // フィルタ検証: highpass かつ周波数 120Hz, Q 0.7（以前の bandpass 1800Hz ではないこと）
    assert.strictEqual(cam.filterNode.type, 'highpass', 'FilterNode のタイプが highpass であること');
    assert.notStrictEqual(cam.filterNode.type, 'bandpass', '旧タイプ bandpass ではないこと');
    assert.strictEqual(cam.filterNode.frequency.target, 120, 'FilterNode のカットオフ周波数が 120Hz であること');
    assert.notStrictEqual(cam.filterNode.frequency.target, 1800, '旧周波数 1800Hz ではないこと');
    assert.strictEqual(cam.filterNode.Q.target, 0.7, 'FilterNode の Q 値が 0.7 であること');
  });

  await itAsync('1-3. スピーカーホンモード (speaker) における音響パラメータ検証', async () => {
    const cam = new CallAudioManager();
    const audioElem = new MockAudioElement();
    const fakeStream = { id: 'stream-1' };

    await cam.attachRemoteStream(audioElem, fakeStream);
    cam.setMode('speaker');

    // ゲイン検証: 1.0
    assert.strictEqual(cam.gainNode.gain.target, 1.0, 'Speaker モードの GainNode 目標ゲインが 1.0 であること');
    // フィルタ検証: allpass
    assert.strictEqual(cam.filterNode.type, 'allpass', 'Speaker モードの FilterNode タイプが allpass であること');
  });

  await itAsync('1-4. Web Audio API 非対応時のフォールバック音量検証', async () => {
    const cam = new CallAudioManager();
    const audioElem = new MockAudioElement();
    // audioCtx / sourceNode を無効化
    cam.audioCtx = null;
    cam.sourceNode = null;
    cam.audioElement = audioElem;

    cam.setMode('normal');
    await cam.applyAudioProfile();

    assert.strictEqual(audioElem.muted, false, 'フォールバック時は audio.muted が false になること');
    assert.strictEqual(audioElem.volume, 1.0, 'フォールバック時の audio.volume が 1.0 であること');
  });

  await itAsync('1-5. setSinkId の受話口・スピーカー探索ロジック検証', async () => {
    const cam = new CallAudioManager();
    const audioElem = new MockAudioElement();
    cam.audioElement = audioElem;

    // normal モード: Earpiece Receiver を選択
    await cam.trySetSinkId(true);
    assert.strictEqual(audioElem.sinkId, 'dev-earpiece', 'normal モードで受話口 deviceId が適用されること');

    // speaker モード: Speaker を選択
    await cam.trySetSinkId(false);
    assert.strictEqual(audioElem.sinkId, 'dev-speaker', 'speaker モードでスピーカー deviceId が適用されること');

    // デバイスが見つからない場合の default フォールバック
    const origEnumerate = navigator.mediaDevices.enumerateDevices;
    navigator.mediaDevices.enumerateDevices = async () => [];
    await cam.trySetSinkId(true);
    assert.strictEqual(audioElem.sinkId, 'default', '該当なし時に default へフォールバックすること');
    navigator.mediaDevices.enumerateDevices = origEnumerate;
  });

  console.log('\n=== テストスイート 2: タッチガード誤タッチ防止 & 傾きセンサー検証 ===');

  it('2-1. 手動切り替え (toggleTouchGuard) と通話バーのボタン状態同期', () => {
    const tgm = new TouchGuardManager();
    const guardElem = getOrCreateElement('call-touch-guard');
    const guardBtn = getOrCreateElement('touch-guard-button');

    // 初期状態は非アクティブ
    assert.strictEqual(tgm.isActive, false);

    // 手動 ON
    tgm.toggleTouchGuard();
    assert.strictEqual(tgm.isActive, true, 'isActive が true になること');
    assert.strictEqual(tgm.isManual, true, '手動フラグ isManual が true になること');
    assert.strictEqual(guardElem.classList.contains('hidden'), false, 'call-touch-guard の hidden が外れること');
    assert.strictEqual(guardBtn.innerText, '🛡️ 保護中', 'ボタンが「🛡️ 保護中」になること');

    // 手動 OFF
    tgm.toggleTouchGuard();
    assert.strictEqual(tgm.isActive, false, 'isActive が false になること');
    assert.strictEqual(tgm.isManual, false, 'isManual が false になること');
    assert.strictEqual(guardElem.classList.contains('hidden'), true, 'call-touch-guard に hidden が付くこと');
    assert.strictEqual(guardBtn.innerText, '🛡️ 保護', 'ボタンが「🛡️ 保護」に戻ること');
  });

  it('2-2. 誤解除防止ロジック - 単発シングルタップでは解除されない', () => {
    const tgm = new TouchGuardManager();
    const guardElem = getOrCreateElement('call-touch-guard');
    tgm.setTouchGuard(true, true);
    assert.strictEqual(tgm.isActive, true);

    // 耳が画面に当たって離れただけの単発タッチ（200ms）
    guardElem.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 100, clientY: 100 }],
      cancelable: true,
      preventDefault: () => {}
    });

    // 200ms 後に touchend
    guardElem.dispatchEvent({
      type: 'touchend',
      cancelable: true,
      preventDefault: () => {}
    });

    // ロックは維持されること！
    assert.strictEqual(tgm.isActive, true, '単発シングルタップでは解除されないこと');
  });

  it('2-3. 誤解除防止ロジック - 300ms以内のダブルタップでロック解除', () => {
    const tgm = new TouchGuardManager();
    const guardElem = getOrCreateElement('call-touch-guard');
    tgm.setTouchGuard(true, true);
    assert.strictEqual(tgm.isActive, true);

    // 1回目のタップ
    guardElem.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 100, clientY: 100 }],
      cancelable: true,
      preventDefault: () => {}
    });
    guardElem.dispatchEvent({
      type: 'touchend',
      cancelable: true,
      preventDefault: () => {}
    });

    // 150ms 後の2回目のタップ (300ms以内)
    guardElem.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 100, clientY: 100 }],
      cancelable: true,
      preventDefault: () => {}
    });
    guardElem.dispatchEvent({
      type: 'touchend',
      cancelable: true,
      preventDefault: () => {}
    });

    // ロック解除されること！
    assert.strictEqual(tgm.isActive, false, '300ms以内のダブルタップでロック解除されること');
  });

  await itAsync('2-4. 誤解除防止ロジック - 600ms以上の長押しでロック解除', async () => {
    const tgm = new TouchGuardManager();
    const guardElem = getOrCreateElement('call-touch-guard');
    tgm.setTouchGuard(true, true);
    assert.strictEqual(tgm.isActive, true);

    guardElem.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 100, clientY: 100 }],
      cancelable: true,
      preventDefault: () => {}
    });

    // 650ms 待機
    await new Promise(resolve => setTimeout(resolve, 650));

    // ロック解除されること！
    assert.strictEqual(tgm.isActive, false, '600ms以上の長押しでロック解除されること');

    guardElem.dispatchEvent({
      type: 'touchend',
      cancelable: true,
      preventDefault: () => {}
    });
  });

  await itAsync('2-5. 誤解除防止ロジック - 指の移動/擦れ(touchmove)で長押しキャンセル', async () => {
    const tgm = new TouchGuardManager();
    const guardElem = getOrCreateElement('call-touch-guard');
    tgm.setTouchGuard(true, true);
    assert.strictEqual(tgm.isActive, true);

    // 耳が擦れて動いた場合
    guardElem.dispatchEvent({
      type: 'touchstart',
      touches: [{ clientX: 100, clientY: 100 }],
      cancelable: true,
      preventDefault: () => {}
    });

    // 30px 移動 (dx > 25)
    guardElem.dispatchEvent({
      type: 'touchmove',
      touches: [{ clientX: 140, clientY: 100 }],
      cancelable: true,
      preventDefault: () => {}
    });

    // 650ms 待機
    await new Promise(resolve => setTimeout(resolve, 650));

    // 擦れ・移動のため長押し解除は無効化され、ロック維持されること！
    assert.strictEqual(tgm.isActive, true, '指の移動(dx > 25)で長押しがキャンセルされロック維持されること');

    guardElem.dispatchEvent({
      type: 'touchend',
      cancelable: true,
      preventDefault: () => {}
    });
  });

  it('2-6. 自動耳あて検知（傾きセンサー連動）- 通常通話中の耳あて姿勢と離脱姿勢', () => {
    const tgm = new TouchGuardManager();
    global.activeCall = { id: 'call-1' };
    callAudioManager.setMode('normal');

    tgm.setTouchGuard(false, false);
    assert.strictEqual(tgm.isActive, false);

    // 耳あて姿勢 (beta: 80, gamma: 10)
    tgm.handleOrientation({ beta: 80, gamma: 10 });
    assert.strictEqual(tgm.isActive, true, '耳あて姿勢 (beta 80, gamma 10) で自動ガードがONになること');
    assert.strictEqual(tgm.isManual, false, '自動ON時は isManual が false であること');

    // 耳から離して水平姿勢 (beta: 25, gamma: 0)
    tgm.handleOrientation({ beta: 25, gamma: 0 });
    assert.strictEqual(tgm.isActive, false, '耳から離した姿勢 (beta 25) で自動ガードがOFFになること');
  });

  it('2-7. 自動耳あて検知 - 手動ロック時は端末の傾きで勝手に解除されない', () => {
    const tgm = new TouchGuardManager();
    global.activeCall = { id: 'call-1' };
    callAudioManager.setMode('normal');

    // ユーザーが手動でロックをON
    tgm.setTouchGuard(true, true);
    assert.strictEqual(tgm.isActive, true);
    assert.strictEqual(tgm.isManual, true);

    // 水平姿勢に戻す (beta: 25, gamma: 0)
    tgm.handleOrientation({ beta: 25, gamma: 0 });
    assert.strictEqual(tgm.isActive, true, '手動ロック時は端末を水平にしても解除されないこと');
  });

  it('2-8. 自動耳あて検知 - スピーカーホンモード時は自動ガードが発動しない', () => {
    const tgm = new TouchGuardManager();
    global.activeCall = { id: 'call-1' };
    callAudioManager.setMode('speaker');

    tgm.setTouchGuard(false, false);
    assert.strictEqual(tgm.isActive, false);

    // スピーカーホンモードで耳あて姿勢
    tgm.handleOrientation({ beta: 80, gamma: 10 });
    assert.strictEqual(tgm.isActive, false, 'スピーカーホンモード時は耳あて姿勢でも自動ガードは発動しないこと');
  });

  it('2-9. 通話タイマーとクリーンアップ (cleanup)', () => {
    const tgm = new TouchGuardManager();
    const guardElem = getOrCreateElement('call-touch-guard');
    const timeElem = getOrCreateElement('touch-guard-time');

    tgm.setTouchGuard(true, true);
    tgm.startCallTimer();
    assert.ok(tgm.timerInterval, 'タイマーが開始されていること');

    // クリーンアップ
    tgm.cleanup();
    assert.strictEqual(tgm.isActive, false, 'cleanup 後は isActive が false');
    assert.strictEqual(guardElem.classList.contains('hidden'), true, 'hidden クラスが付加されること');
    assert.strictEqual(tgm.timerInterval, null, 'タイマーが停止していること');
    assert.strictEqual(timeElem.innerText, '00:00', '通話時間が 00:00 にリセットされること');
  });

  it('2-10. 通話終了フロー (endCall / endCallUI) と連携したタッチガード完全消去検証', () => {
    // グローバルインスタンスの touchGuardManager をアクティブにする
    touchGuardManager.setTouchGuard(true, true);
    touchGuardManager.startCallTimer();
    global.activeCall = { id: 'test-call', close: () => {} };

    const guardElem = getOrCreateElement('call-touch-guard');
    assert.strictEqual(guardElem.classList.contains('hidden'), false, '通話中はガード表示');

    // endCallUI 実行（ダミー補助関数）
    global.stopLocalAudioStream = () => {};
    global.closeCallModal = () => {};
    global.closeIncomingCallModal = () => {};
    global.releaseCallWakeLock = () => {};
    global.showCallBar = () => {};

    // appJs から抽出した endCallUI ロジックを実行
    const endCallUISnippet = appJsCode.slice(
      appJsCode.indexOf('function endCallUI() {'),
      appJsCode.indexOf('async function requestCallWakeLock()')
    );
    vm.runInThisContext(endCallUISnippet);

    endCallUI();

    assert.strictEqual(touchGuardManager.isActive, false, 'endCallUI により touchGuardManager が非アクティブ化');
    assert.strictEqual(guardElem.classList.contains('hidden'), true, 'call-touch-guard に hidden が付与されていること');
    assert.strictEqual(global.activeCall, null, 'activeCall が null にクリアされていること');
  });

  console.log('\n=== テストスイート 3: HTML / CSS の構造整合性検証 ===');

  it('3-1. index.html の DOM 要素検証', () => {
    const htmlPath = path.resolve(__dirname, 'index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(htmlContent.includes('id="call-touch-guard"'), 'id="call-touch-guard" が存在すること');
    assert.ok(htmlContent.includes('class="call-touch-guard hidden"'), '初期クラスに hidden が含まれること');
    assert.ok(htmlContent.includes('id="touch-guard-time"'), 'id="touch-guard-time" が存在すること');
    assert.ok(htmlContent.includes('id="touch-guard-button"'), 'id="touch-guard-button" が存在すること');
    assert.ok(htmlContent.includes('id="touch-guard-mode"'), 'id="touch-guard-mode" が存在すること');
    assert.ok(htmlContent.includes('id="touch-guard-unlock-area"'), 'id="touch-guard-unlock-area" が存在すること');
    assert.ok(htmlContent.includes('id="call-bar"'), 'id="call-bar" が存在すること');
    assert.ok(htmlContent.includes('id="speakerphone-button"'), 'id="speakerphone-button" が存在すること');
    assert.ok(htmlContent.includes('id="call-mode-badge"'), 'id="call-mode-badge" が存在すること');
  });

  it('3-2. style.css のスタイル定義検証', () => {
    const cssPath = path.resolve(__dirname, 'style.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    const requiredSelectors = [
      '.call-touch-guard',
      '.call-touch-guard.hidden',
      '.touch-guard-content',
      '.touch-guard-status',
      '.touch-guard-pulse',
      '.touch-guard-mode-text',
      '.touch-guard-time-text',
      '.touch-guard-unlock-area',
      '.touch-guard-unlock-icon',
      '.touch-guard-unlock-hint',
      '.btn-call-guard',
      '.call-bar',
      '.call-mode-badge'
    ];

    for (const sel of requiredSelectors) {
      assert.ok(cssContent.includes(sel), `CSS に ${sel} が定義されていること`);
    }

    // z-index: 99999 (最前面全画面ガード) であること
    assert.ok(cssContent.includes('z-index: 99999;'), 'タッチガードの z-index が 99999 であること');
    // background: #000000 (完全ブラックアウト) であること
    assert.ok(cssContent.includes('background: #000000;'), '完全ブラックアウト用の背景色が指定されていること');
  });

  console.log(`\n========================================`);
  console.log(`結果: ${passedTests} / ${totalTests} テスト合格 (100%)`);
  console.log(`========================================\n`);
}

runTests().catch(err => {
  console.error('テスト実行中に例外が発生しました:', err);
  process.exit(1);
});
