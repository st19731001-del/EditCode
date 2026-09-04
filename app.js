// ================= 設定領域 =================
// ※ステップ3：GitHub Discussions連携用設定
const GITHUB_CONFIG = {
  owner: 'st19731001-del',  // あなたのGitHubユーザー名
  repo: 'st19731001-del.github.io', // リポジトリ名
  // トークンはlocalStorageに保存するか、一時的に直接指定します
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
      appendMessage(data.text, 'partner-msg');
    }
  });

  activeConn.on('close', () => {
    document.querySelector('.status-dot').style.background = '#777';
    document.querySelector('.partner-name').innerText = 'Partner (Offline)';
    activeConn = null;
  });
}

// ================= メッセージ送信（ハイブリッド） =================
async function sendMsg() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  // 1. 相手がオンラインならWebRTC（P2P）で直接即時送信
  if (activeConn && activeConn.open) {
    activeConn.send({ type: 'chat', text: text });
    appendMessage(text, 'my-msg');
  } else {
    // 2. オフラインならGitHub API（Discussions）へ保管送信
    appendMessage(text, 'my-msg pending');
    await saveMessageToGitHub(text);
    const pendingMsg = document.querySelector('.pending');
    if (pendingMsg) pendingMsg.classList.remove('pending');
  }

  input.value = '';
}

// GitHub APIへメッセージ保存 (Discussions API / GraphQL)
async function saveMessageToGitHub(text) {
  const token = GITHUB_CONFIG.getToken();
  if (!token) {
    console.log('GitHub Token未設定のためローカルのみ表示');
    return;
  }

  const payload = {
    sender: myRole,
    text: text,
    timestamp: new Date().toISOString(),
    isRead: false
  };

  // ※GitHub Discussions APIへコメント投稿処理（ステップ3実処理）
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

function appendMessage(text, className) {
  const list = document.getElementById('message-list');
  const msg = document.createElement('div');
  msg.className = `msg ${className}`;
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
}

// 傾きセンサー（パニックモード）
if (window.DeviceOrientationEvent) {
  window.addEventListener('deviceorientation', (event) => {
    if (event.beta < -150 || event.beta > 150) {
      hideToEditor();
    }
  });
}
