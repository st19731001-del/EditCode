// ================= 設定領域 =================
const GITHUB_CONFIG = {
  owner: 'st19731001-del',
  repo: 'st19731001-del.github.io',
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
  console.log('My ID:', id);
  connectToPartner();
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
      // 相手から削除通知が届いたら該当メッセージを画面から消去
      removeMessageFromDOM(data.id);
    }
  });

  activeConn.on('close', () => {
    if (statusDot) statusDot.style.background = '#777';
    if (partnerName) partnerName.innerText = 'Partner (Offline)';
    activeConn = null;
  });
}

// ================= メッセージ送信 =================
async function sendMsg() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

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

// ================= メッセージ削除（長押し機能） =================
function attachLongPressDelete(msgElement, msgId) {
  let timer = null;

  // スマホ長押しイベント
  msgElement.addEventListener('touchstart', () => {
    timer = setTimeout(() => {
      if (confirm('このメッセージを削除（取り消し）しますか？')) {
        deleteMessage(msgElement, msgId);
      }
    }, 500); // 0.5秒長押しで発動
  }, { passive: true });

  msgElement.addEventListener('touchend', () => clearTimeout(timer));
  msgElement.addEventListener('touchmove', () => clearTimeout(timer));

  // PC用（右クリック削除）
  msgElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (confirm('このメッセージを削除（取り消し）しますか？')) {
      deleteMessage(msgElement, msgId);
    }
  });
}

function deleteMessage(element, msgId) {
  element.remove();
  // オンライン中なら相手の画面からも消去命令を送信
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

// GitHub APIへメッセージ保存
async function saveMessageToGitHub(text, isStamp = false, msgId) {
  const token = GITHUB_CONFIG.getToken();
  if (!token) return;

  const payload = {
    id: msgId,
    sender: myRole,
    text: text,
    isStamp: isStamp,
    timestamp: new Date().toISOString(),
    isRead: false
  };
  console.log('GitHub Discussionsへ保存:', payload);
}

// ================= 通話・画面制御 =================
async function startCall() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const call = peer.call(targetRole, stream);
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
  
  // 長押し削除機能をバインド
  attachLongPressDelete(msg, msgId);

  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
}

function switchToSecret() {
  document.getElementById('editor-screen').classList.add('hidden');
  document.getElementById('secret-screen').classList.remove('hidden');
  // 画面を開いた際、接続されていなければ再接続を試みる
  connectToPartner();
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
