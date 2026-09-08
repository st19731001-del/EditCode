// ================= 設定領域 =================
const VERCEL_API_URL = 'https://editcode-push.vercel.app/api/push';
const VAPID_PUBLIC_KEY = 'BK4M5xmRO3I6Kuhv2sGBfRX4A4cXpAHCdmj74cxLFD3ytLqmyCzooRC_LUny8cXzwNs_npD3cMfuYRqsYMbADK0';

const GITHUB_CONFIG = {
  owner: 'st19731001-del',
  repo: 'EditCode',
  getToken: () => {
    try {
      return localStorage.getItem('gh_token') || '';
    } catch(e) {
      return '';
    }
  }
};

const SECRET_PIN = '904900';

const savedRole = localStorage.getItem('user_role');
const urlParams = new URLSearchParams(window.location.search);
const urlRole = urlParams.get('user') === 'b' ? 'user_b' : (urlParams.get('user') === 'a' ? 'user_a' : null);

const myRole = savedRole || urlRole || 'user_a';
const targetRole = myRole === 'user_a' ? 'user_b' : 'user_a';

let peer = null;
let activeConn = null;
let currentCall = null;
let localAudioStream = null;
let currentFileSha = null;
let isAuthorized = false;

// UI Elements
const pinModal = document.getElementById('pinModal');
const pinInput = document.getElementById('pinInput');
const pinSubmit = document.getElementById('pinSubmit');
const mainApp = document.getElementById('mainApp');
const roleDisplay = document.getElementById('roleDisplay');
const peerStatus = document.getElementById('peerStatus');
const editor = document.getElementById('editor');
const fileSelect = document.getElementById('fileSelect');
const saveBtn = document.getElementById('saveBtn');
const callBtn = document.getElementById('callBtn');
const endCallBtn = document.getElementById('endCallBtn');
const chatInput = document.getElementById('chatInput');
const sendChatBtn = document.getElementById('sendChatBtn');
const chatMessages = document.getElementById('chatMessages');
const tokenInput = document.getElementById('tokenInput');
const saveTokenBtn = document.getElementById('saveTokenBtn');

// ================= Push / ServiceWorker 処理 =================
async function registerServiceWorkerAndPush() {
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      console.log('ServiceWorker registered:', registration);

      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          const convertedKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: convertedKey
          });
        }
        localStorage.setItem('push_subscription_' + myRole, JSON.stringify(subscription));
      }
    } catch (err) {
      console.error('ServiceWorker / Push error:', err);
    }
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function triggerPushNotification() {
  const targetSubscriptionStr = localStorage.getItem('push_subscription_' + targetRole);
  
  if (!targetSubscriptionStr) {
    alert('相手の通知トークンがありません。相手が一度アプリを開き通知を許可する必要があります。');
    return;
  }

  try {
    const response = await fetch(VERCEL_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: JSON.parse(targetSubscriptionStr),
        title: '[System] Maintenance',
        body: 'システムアップデートの準備が完了しました。確認してください。'
      })
    });

    if (response.ok) {
      alert('バックグラウンド呼び出し（通知）を送信しました');
    } else {
      alert('通知送信に失敗しました');
    }
  } catch (err) {
    console.error('Push Trigger Error:', err);
    alert('送信エラーが発生しました');
  }
}

// ================= 認証・初期化 =================
function checkAuth() {
  const savedPin = localStorage.getItem('auth_pin');
  if (savedPin === SECRET_PIN) {
    unlockApp();
  } else {
    if (pinModal) pinModal.style.display = 'flex';
  }
}

function unlockApp() {
  isAuthorized = true;
  if (pinModal) pinModal.style.display = 'none';
  if (mainApp) mainApp.style.display = 'block';
  if (roleDisplay) roleDisplay.textContent = `Role: ${myRole.toUpperCase()}`;
  
  if (tokenInput) tokenInput.value = GITHUB_CONFIG.getToken();

  initPeer();
  loadFile('index.html');
  registerServiceWorkerAndPush();
}
if (pinSubmit) {
  pinSubmit.addEventListener('click', () => {
    if (pinInput.value === SECRET_PIN) {
      localStorage.setItem('auth_pin', SECRET_PIN);
      unlockApp();
    } else {
      alert('PINコードが違います');
      pinInput.value = '';
    }
  });
}

if (saveTokenBtn) {
  saveTokenBtn.addEventListener('click', () => {
    localStorage.setItem('gh_token', tokenInput.value.trim());
    alert('GitHub Tokenを保存しました');
  });
}

// ================= PeerJS (P2P通信 & 通話) =================
function initPeer() {
  peer = new Peer(myRole);

  peer.on('open', (id) => {
    if (peerStatus) peerStatus.textContent = 'オンライン (接続待機中)';
    connectToTarget();
  });

  peer.on('connection', (conn) => {
    setupConnection(conn);
  });

  peer.on('call', async (call) => {
    if (confirm('着信があります。通話を開始しますか？')) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localAudioStream = stream;
        call.answer(stream);
        handleCallStream(call);
      } catch (err) {
        alert('マイクの取得に失敗しました');
      }
    }
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    if (peerStatus) peerStatus.textContent = '通信エラー / オフライン';
  });
}

function connectToTarget() {
  const conn = peer.connect(targetRole);
  setupConnection(conn);
}

function setupConnection(conn) {
  activeConn = conn;

  conn.on('open', () => {
    if (peerStatus) peerStatus.textContent = `接続完了 (${targetRole})`;
  });

  conn.on('data', (data) => {
    if (data.type === 'code_update') {
      if (editor && editor.value !== data.content) {
        editor.value = data.content;
      }
    } else if (data.type === 'chat') {
      appendChatMessage(targetRole, data.message);
    }
  });

  conn.on('close', () => {
    if (peerStatus) peerStatus.textContent = '相手が切断しました';
    activeConn = null;
  });
}

// ================= 通話処理 =================
async function startCall() {
  if (activeConn && activeConn.open) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localAudioStream = stream;
      const call = peer.call(targetRole, stream);
      handleCallStream(call);
    } catch (err) {
      alert('マイクのアクセス許可が必要です');
    }
  } else {
    if (confirm('相手がオフラインです。「システムアップデート」の呼び出し通知を送信しますか？')) {
      await triggerPushNotification();
    }
  }
}

function handleCallStream(call) {
  currentCall = call;
  if (callBtn) callBtn.style.display = 'none';
  if (endCallBtn) endCallBtn.style.display = 'inline-block';

  call.on('stream', (remoteStream) => {
    let remoteAudio = document.getElementById('remoteAudio');
    if (!remoteAudio) {
      remoteAudio = document.createElement('audio');
      remoteAudio.id = 'remoteAudio';
      remoteAudio.autoplay = true;
      document.body.appendChild(remoteAudio);
    }
    remoteAudio.srcObject = remoteStream;
  });

  call.on('close', endCall);
}

function endCall() {
  if (currentCall) currentCall.close();
  if (localAudioStream) {
    localAudioStream.getTracks().forEach(track => track.stop());
  }
  if (callBtn) callBtn.style.display = 'inline-block';
  if (endCallBtn) endCallBtn.style.display = 'none';
}

if (callBtn) callBtn.addEventListener('click', startCall);
if (endCallBtn) endCallBtn.addEventListener('click', endCall);

// ================= チャット & リアルタイム同期 =================
function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;

  appendChatMessage(myRole, msg);

  if (activeConn && activeConn.open) {
    activeConn.send({ type: 'chat', message: msg });
  }
  chatInput.value = '';
}

function appendChatMessage(sender, message) {
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.textContent = `[${sender}]: ${message}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

if (sendChatBtn) sendChatBtn.addEventListener('click', sendChat);
if (chatInput) {
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChat();
  });
}

if (editor) {
  editor.addEventListener('input', () => {
    if (activeConn && activeConn.open) {
      activeConn.send({ type: 'code_update', content: editor.value });
    }
  });
}

// ================= GitHub REST API (ファイル読込・保存) =================
async function loadFile(path) {
  const token = GITHUB_CONFIG.getToken();
  const url = `https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${path}`;
  
  try {
    const headers = {};
    if (token) headers['Authorization'] = `token ${token}`;

    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = await res.json();
      currentFileSha = data.sha;
      const content = decodeURIComponent(escape(atob(data.content)));
      if (editor) editor.value = content;
    }
  } catch (err) {
    console.error('File load error:', err);
  }
}

async function saveFile() {
  const token = GITHUB_CONFIG.getToken();
  if (!token) {
    alert('GitHub Tokenが設定されていません');
    return;
  }

  const path = fileSelect ? fileSelect.value : 'index.html';
  const url = `https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${path}`;
  const content = btoa(unescape(encodeURIComponent(editor.value)));

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `Update ${path} via App`,
        content: content,
        sha: currentFileSha
      })
    });

    if (res.ok) {
      const data = await res.json();
      currentFileSha = data.content.sha;
      alert('保存が完了しました！');
    } else {
      alert('保存に失敗しました');
    }
  } catch (err) {
    console.error('Save error:', err);
    alert('エラーが発生しました');
  }
}

if (fileSelect) {
  fileSelect.addEventListener('change', (e) => {
    loadFile(e.target.value);
  });
}

if (saveBtn) saveBtn.addEventListener('click', saveFile);

// 初期実行
window.addEventListener('DOMContentLoaded', checkAuth);
