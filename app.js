// 2人の固定ID設定 (AさんとBさんでURLパラメータを変える設定)
const urlParams = new URLSearchParams(window.location.search);
const myRole = urlParams.get('user') === 'b' ? 'user_b' : 'user_a';
const targetRole = myRole === 'user_a' ? 'user_b' : 'user_a';

// PeerJSの初期化 (固定ID)
const peer = new Peer(myRole);
let activeConn = null;
let activeCall = null;

// PeerJS接続完了時
peer.on('open', (id) => {
  console.log('My ID:', id);
  // 相手へ自動接続を試みる
  connectToPartner();
});

// 相手からのチャット接続を受信
peer.on('connection', (conn) => {
  activeConn = conn;
  setupConnectionEvents();
});

// 相手からの通話着信を受信
peer.on('call', async (call) => {
  if (confirm('通話の着信があります。応答しますか？')) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    call.answer(stream);
    handleStream(call);
  }
});

// 相手への自動接続処理
function connectToPartner() {
  if (activeConn) return;
  const conn = peer.connect(targetRole);
  conn.on('open', () => {
    activeConn = conn;
    setupConnectionEvents();
  });
}

// 接続イベント設定 (データ受信・ステータス更新)
function setupConnectionEvents() {
  document.querySelector('.status-dot').style.background = '#4caf50'; // 緑アイコン(Online)
  document.querySelector('.partner-name').innerText = 'Partner (Online)';

  activeConn.on('data', (data) => {
    if (data.type === 'chat') {
      appendMessage(data.text, 'partner-msg');
    }
  });

  activeConn.on('close', () => {
    document.querySelector('.status-dot').style.background = '#777'; // 灰色アイコン(Offline)
    document.querySelector('.partner-name').innerText = 'Partner (Offline)';
    activeConn = null;
  });
}

// メッセージ送信
function sendMsg() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  // 相手がオンラインならWebRTCで即時送信
  if (activeConn && activeConn.open) {
    activeConn.send({ type: 'chat', text: text });
  } else {
    // オフライン時はステップ3でGitHub API送信を組み込みます
    console.log('Offline: ステップ3で保存処理を実行');
  }

  appendMessage(text, 'my-msg');
  input.value = '';
}

// 画面にメッセージを追加
function appendMessage(text, className) {
  const list = document.getElementById('message-list');
  const msg = document.createElement('div');
  msg.className = `msg ${className}`;
  msg.innerText = text;
  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
}

// 通話開始機能
async function startCall() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const call = peer.call(targetRole, stream);
    handleStream(call);
  } catch (err) {
    alert('マイクのアクセス許可が必要です');
  }
}

// 通話音声の再生
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

// 画面切替 & パニックモード制御
function switchToSecret() {
  document.getElementById('editor-screen').classList.add('hidden');
  document.getElementById('secret-screen').classList.remove('hidden');
  connectToPartner(); // 画面を開いた際に接続再試行
}

function hideToEditor() {
  document.getElementById('secret-screen').classList.add('hidden');
  document.getElementById('editor-screen').classList.remove('hidden');
}

// 傾きセンサー
if (window.DeviceOrientationEvent) {
  window.addEventListener('deviceorientation', (event) => {
    if (event.beta < -150 || event.beta > 150) {
      hideToEditor();
    }
  });
}
