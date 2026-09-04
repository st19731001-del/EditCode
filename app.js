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
  if (activeConn) return;
  const conn = peer.connect(targetRole);
  conn.on('open', () => {
    activeConn = conn;
    setupConnectionEvents();
  });
}

function setupConnectionEvents() {
  document.querySelector('.status-dot').style.background = '#4caf50';
  document.querySelector('.partner-name').innerText = 'Partner (Online)';

  activeConn.on('data', (data) => {
    if (data.type === 'chat') {
      appendMessage(data.text, 'partner-msg', data.isStamp);
    }
  });

  activeConn.on('close', () => {
    document.querySelector('.status-dot').style.background = '#777';
    document.querySelector('.partner-name').innerText = 'Partner (Offline)';
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
  // 送信時にスタンプパレットが開いていれば閉じる
  document.getElementById('stamp-palette').classList.add('hidden');
}

// ================= スタンプ送信 =================
async function sendStamp(emoji) {
  await dispatchMessage(emoji, true);
  document.getElementById('stamp-palette').classList.add('hidden');
}

// 通信用共通送信関数
async function dispatchMessage(text, isStamp = false) {
  if (activeConn && activeConn.open) {
    activeConn.send({ type: 'chat', text: text, isStamp: isStamp });
    appendMessage(text, 'my-msg', isStamp);
  } else {
    appendMessage(text, 'my-msg pending', isStamp);
    await saveMessageToGitHub(text, isStamp);
    const pendingMsg = document.querySelector('.pending');
    if (pendingMsg) pendingMsg.classList.remove('pending');
  }
}

// スタンプパレット開閉表示
function toggleStampPalette() {
  const palette = document.getElementById('stamp-palette');
  palette.classList.toggle('hidden');
}

// GitHub APIへメッセージ保存 (Discussions API)
async function saveMessageToGitHub(text, isStamp = false) {
  const token = GITHUB_CONFIG.getToken();
  if (!token) return;

  const payload = {
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

function appendMessage(text, className, isStamp = false) {
  const list = document.getElementById('message-list');
  const msg = document.createElement('div');
  msg.className = `msg ${className} ${isStamp ? 'stamp-msg' : ''}`;
  msg.innerText = text;
  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
}

function switchToSecret() {
  document.getElementById('editor-screen').classList.add('hidden');
  document.getElementById('secret-screen').classList.remove('hidden');
  connectToPartner();
}

function hideToEditor() {
  document.getElementById('secret-screen').classList.add('hidden');
  document.getElementById('editor-screen').classList.remove('hidden');
  document.getElementById('stamp-palette').classList.add('hidden');
}

// 傾きセンサー（パニックモード）
if (window.DeviceOrientationEvent) {
  window.addEventListener('deviceorientation', (event) => {
    if (event.beta < -150 || event.beta > 150) {
      hideToEditor();
    }
  });
}
