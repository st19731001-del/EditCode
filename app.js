// ================= 設定領域 =================
const GITHUB_CONFIG = {
  owner: 'st19731001-del',
  repo: 'st19731001-del.github.io',
  // ブラウザの内部領域(localStorage)からトークンを取得
  getToken: () => localStorage.getItem('gh_token') || ''
};

// 2人の固定ID設定 (?user=b でアクセスするとuser_bになります)
const urlParams = new URLSearchParams(window.location.search);
const myRole = urlParams.get('user') === 'b' ? 'user_b' : 'user_a';
const targetRole = myRole === 'user_a' ? 'user_b' : 'user_a';

// PeerJSの初期化
const peer = new Peer(myRole);
let activeConn = null;
let activeCall = null;

// PeerJS イベントハンドラ
peer.on('open', (id) => {
  connectToPartner();
  fetchOfflineMessages();
});

peer.on('connection', (conn) => {
  activeConn = conn;
  setupConnectionEvents();
});

peer.on('call', async (call) => {
  if (confirm('通話の着信があります。応答しますか？')) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    call.answer(stream);
    handleStream(call);
  }
});

function connectToPartner() {
  if (activeConn && activeConn.open) return;
  const conn = peer.connect(targetRole, { reliable: true });
  conn.on('open', () => {
    activeConn = conn;
    setupConnectionEvents();
  });
}

function setupConnectionEvents() {
  const statusDot = document.querySelector('.status-dot');
  const partnerName = document.querySelector('.partner-name');
  
  if (statusDot) statusDot.style.background = '#4caf50';
  if (partnerName) partnerName.innerText = 'Partner (Online)';

  activeConn.on('data', (data) => {
    if (data.type === 'chat') {
      appendMessage(data.text, 'partner-msg', data.isStamp, data.id);
    } else if (data.type === 'delete') {
      removeMessageFromDOM(data.id);
    }
  });

  activeConn.on('close', () => {
    if (statusDot) statusDot.style.background = '#777';
    if (partnerName) partnerName.innerText = 'Partner (Offline)';
    activeConn = null;
  });
}

// ================= メッセージ送信 (トークン自動登録対応) =================
async function sendMsg() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  // ★トークン入力（ghp_で始まる文字列）の自動検知・記憶処理
  if (text.startsWith('ghp_')) {
    localStorage.setItem('gh_token', text);
    appendSystemMsg('🔑 通信キーの設定が完了しました！オフライン機能が有効です。');
    input.value = '';
    document.getElementById('stamp-palette').classList.add('hidden');
    fetchOfflineMessages();
    return;
  }

  await dispatchMessage(text, false);
  input.value = '';
  document.getElementById('stamp-palette').classList.add('hidden');
}

async function sendStamp(emoji) {
  await dispatchMessage(emoji, true);
  document.getElementById('stamp-palette').classList.add('hidden');
}

async function dispatchMessage(text, isStamp = false) {
  const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  
  if (activeConn && activeConn.open) {
    activeConn.send({ type: 'chat', text: text, isStamp: isStamp, id: msgId });
    appendMessage(text, 'my-msg', isStamp, msgId);
  } else {
    appendMessage(text, 'my-msg pending', isStamp, msgId);
    await saveMessageToGitHub(text, isStamp, msgId);
    const pendingMsg = document.querySelector('.pending');
    if (pendingMsg) pendingMsg.classList.remove('pending');
  }
}

// ================= GitHub API 連携 =================
async function saveMessageToGitHub(text, isStamp, msgId) {
  const token = GITHUB_CONFIG.getToken();
  if (!token) return;

  const bodyData = JSON.stringify({
    id: msgId,
    sender: myRole,
    target: targetRole,
    text: text,
    isStamp: isStamp,
    timestamp: new Date().toISOString()
  });

  try {
    await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: `MSG_${msgId}`,
        body: bodyData,
        labels: ['offline-msg']
      })
    });
  } catch (err) {
    console.error('GitHub保存エラー:', err);
  }
}

async function fetchOfflineMessages() {
  const token = GITHUB_CONFIG.getToken();
  if (!token) return;

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues?labels=offline-msg`, {
      headers: { 'Authorization': `token ${token}` }
    });
    const issues = await res.json();
    
    let count = 0;
    if (Array.isArray(issues)) {
      issues.forEach(issue => {
        try {
          const data = JSON.parse(issue.body);
          if (data.target === myRole) {
            appendMessage(data.text, 'partner-msg', data.isStamp, data.id);
            count++;
            closeGitHubIssue(issue.number, token);
          }
        } catch (e) {}
      });
    }

    if (count > 0) updateBadge(count);
  } catch (err) {
    console.error('未読取得エラー:', err);
  }
}

async function closeGitHubIssue(issueNumber, token) {
  await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ state: 'closed' })
  });
}

function updateBadge(count) {
  if ('setAppBadge' in navigator) {
    if (count > 0) {
      navigator.setAppBadge(count);
    } else {
      navigator.clearAppBadge();
    }
  }
}

// ================= メッセージ削除（長押し機能） =================
function attachLongPressDelete(msgElement, msgId) {
  let timer = null;

  msgElement.addEventListener('touchstart', () => {
    timer = setTimeout(() => {
      if (confirm('このメッセージを削除（取り消し）しますか？')) {
        deleteMessage(msgElement, msgId);
      }
    }, 500);
  }, { passive: true });

  msgElement.addEventListener('touchend', () => clearTimeout(timer));
  msgElement.addEventListener('touchmove', () => clearTimeout(timer));

  msgElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (confirm('このメッセージを削除（取り消し）しますか？')) {
      deleteMessage(msgElement, msgId);
    }
  });
}

function deleteMessage(element, msgId) {
  element.remove();
  if (activeConn && activeConn.open) {
    activeConn.send({ type: 'delete', id: msgId });
  }
}

function removeMessageFromDOM(msgId) {
  const target = document.querySelector(`[data-id="${msgId}"]`);
  if (target) target.remove();
}

function toggleStampPalette() {
  const palette = document.getElementById('stamp-palette');
  palette.classList.toggle('hidden');
}

// ================= 通話・画面制御 =================
async function startCall() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    call = peer.call(targetRole, stream);
    handleStream(call);
  } catch (err) {
    alert('マイクのアクセス許可が必要です');
  }
}

function handleStream(call) {
  activeCall = call;
  call.on('stream', (remoteStream) => {
    let audio = document.getElementById('remote-audio');
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'remote-audio';
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = remoteStream;
  });
}

function appendMessage(text, className, isStamp = false, msgId = '') {
  const list = document.getElementById('message-list');
  const msg = document.createElement('div');
  msg.className = `msg ${className} ${isStamp ? 'stamp-msg' : ''}`;
  msg.innerText = text;
  if (msgId) msg.setAttribute('data-id', msgId);
  
  attachLongPressDelete(msg, msgId);

  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
}

function appendSystemMsg(text) {
  const list = document.getElementById('message-list');
  const msg = document.createElement('div');
  msg.className = 'system-msg';
  msg.innerText = text;
  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
}

function switchToSecret() {
  document.getElementById('editor-screen').classList.add('hidden');
  document.getElementById('secret-screen').classList.remove('hidden');
  connectToPartner();
  updateBadge(0);
}

function hideToEditor() {
  document.getElementById('secret-screen').classList.add('hidden');
  document.getElementById('editor-screen').classList.remove('hidden');
  document.getElementById('stamp-palette').classList.add('hidden');
}

// 傾きセンサー
if (window.DeviceOrientationEvent) {
  window.addEventListener('deviceorientation', (event) => {
    if (event.beta < -150 || event.beta > 150) {
      hideToEditor();
    }
  });
}
