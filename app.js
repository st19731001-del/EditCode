// ================= 設定領域 =================
const GITHUB_CONFIG = {
  owner: 'st19731001-del',
  repo: 'st19731001-del.github.io',
  getToken: () => localStorage.getItem('gh_token') || ''
};

const urlParams = new URLSearchParams(window.location.search);
const myRole = urlParams.get('user') === 'b' ? 'user_b' : 'user_a';
const targetRole = myRole === 'user_a' ? 'user_b' : 'user_a';

const peer = new Peer(myRole);
let activeConn = null;
let activeCall = null;
let currentReplyTo = null; // 現在リプライ対象のメッセージ

// ローカルストレージ管理
function getStoredMessages() {
  return JSON.parse(localStorage.getItem('chat_history') || '[]');
}

function saveStoredMessages(messages) {
  const now = Date.now();
  const threeDays = 3 * 24 * 60 * 60 * 1000;
  const filtered = messages.filter(m => (now - m.timestamp) < threeDays);
  localStorage.setItem('chat_history', JSON.stringify(filtered));
  return filtered;
}

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

  if (activeConn && activeConn.open) {
    activeConn.send({ type: 'read_ack' });
    markMyMessagesAsRead();
  }

  activeConn.on('data', (data) => {
    if (data.type === 'chat') {
      const msgObj = {
        id: data.id,
        text: data.text,
        replyText: data.replyText || null,
        sender: 'partner',
        isStamp: data.isStamp,
        isRead: true,
        timestamp: Date.now()
      };
      saveAndRenderNewMessage(msgObj);
      activeConn.send({ type: 'read_ack', id: data.id });
    } else if (data.type === 'read_ack') {
      markMyMessagesAsRead(data.id);
    } else if (data.type === 'delete') {
      deleteLocalMessage(data.id);
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

  if (text.toLowerCase() === 'reload') {
    location.reload(true);
    return;
  }

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
  cancelReply();
  document.getElementById('stamp-palette').classList.add('hidden');
}

async function sendStamp(emoji) {
  await dispatchMessage(emoji, true);
  cancelReply();
  document.getElementById('stamp-palette').classList.add('hidden');
}

async function dispatchMessage(text, isStamp = false) {
  const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const isOnline = activeConn && activeConn.open;
  
  const msgObj = {
    id: msgId,
    text: text,
    replyText: currentReplyTo ? currentReplyTo.text : null,
    sender: 'me',
    isStamp: isStamp,
    isRead: isOnline,
    timestamp: Date.now()
  };

  saveAndRenderNewMessage(msgObj);

  if (isOnline) {
    activeConn.send({ 
      type: 'chat', 
      text: text, 
      replyText: msgObj.replyText, 
      isStamp: isStamp, 
      id: msgId 
    });
  } else {
    await saveMessageToGitHub(text, isStamp, msgId, msgObj.replyText);
  }
}

// ================= リプライ操作 =================
function setReplyTarget(text) {
  currentReplyTo = { text: text };
  document.getElementById('reply-text').innerText = text;
  document.getElementById('reply-preview').classList.remove('hidden');
}

function cancelReply() {
  currentReplyTo = null;
  document.getElementById('reply-preview').classList.add('hidden');
}

// ================= 長押しメニュー (コピー / リプライ / 削除) =================
function attachLongPressMenu(msgElement, msgText, msgId) {
  let timer = null;

  const showMenu = () => {
    const choice = prompt("操作を選択してください:\n1: 📋 コピー\n2: 💬 リプライ（返信）\n3: 🗑️ 削除（取り消し）\n\n(数字 1〜3 を入力)", "1");
    if (choice === "1") {
      navigator.clipboard.writeText(msgText);
      alert("コピーしました！");
    } else if (choice === "2") {
      setReplyTarget(msgText);
    } else if (choice === "3") {
      if (confirm("このメッセージを削除しますか？")) {
        deleteMessage(msgId);
      }
    }
  };

  msgElement.addEventListener('touchstart', () => {
    timer = setTimeout(showMenu, 500);
  }, { passive: true });

  msgElement.addEventListener('touchend', () => clearTimeout(timer));
  msgElement.addEventListener('touchmove', () => clearTimeout(timer));

  msgElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu();
  });
}

// ================= 画面描画 =================
function renderAllMessages() {
  const list = document.getElementById('message-list');
  list.innerHTML = '<div class="system-msg">暗号化されたP2P通信が有効です</div>';
  const messages = saveStoredMessages(getStoredMessages());
  messages.forEach(m => renderSingleMessage(m));
}

function saveAndRenderNewMessage(msgObj) {
  const messages = getStoredMessages();
  messages.push(msgObj);
  saveStoredMessages(messages);
  renderSingleMessage(msgObj);
}

function renderSingleMessage(m) {
  const list = document.getElementById('message-list');
  const msgContainer = document.createElement('div');
  const className = m.sender === 'me' ? 'my-msg' : 'partner-msg';
  
  msgContainer.className = `msg ${className} ${m.isStamp ? 'stamp-msg' : ''}`;
  msgContainer.setAttribute('data-id', m.id);

  let html = '';
  if (m.replyText) {
    html += `<div class="reply-quote">↩ ${m.replyText}</div>`;
  }
  html += `<span class="msg-text">${m.text}</span>`;
  if (m.sender === 'me') {
    html += `<span class="read-status">${m.isRead ? '既読' : '未読'}</span>`;
  }
  msgContainer.innerHTML = html;

  attachLongPressMenu(msgContainer, m.text, m.id);
  list.appendChild(msgContainer);
  list.scrollTop = list.scrollHeight;
}

function markMyMessagesAsRead(targetId = null) {
  let messages = getStoredMessages();
  let updated = false;

  messages = messages.map(m => {
    if (m.sender === 'me' && (!targetId || m.id === targetId)) {
      if (!m.isRead) {
        m.isRead = true;
        updated = true;
      }
    }
    return m;
  });

  if (updated) {
    saveStoredMessages(messages);
    renderAllMessages();
  }
}

function deleteLocalMessage(msgId) {
  let messages = getStoredMessages();
  messages = messages.filter(m => m.id !== msgId);
  saveStoredMessages(messages);
  const elem = document.querySelector(`[data-id="${msgId}"]`);
  if (elem) elem.remove();
}

function deleteMessage(msgId) {
  deleteLocalMessage(msgId);
  if (activeConn && activeConn.open) {
    activeConn.send({ type: 'delete', id: msgId });
  }
}

// ================= GitHub API 連携 =================
async function saveMessageToGitHub(text, isStamp, msgId, replyText = null) {
  const token = GITHUB_CONFIG.getToken();
  if (!token) return;

  const bodyData = JSON.stringify({
    id: msgId,
    sender: myRole,
    target: targetRole,
    text: text,
    replyText: replyText,
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
            const msgObj = {
              id: data.id,
              text: data.text,
              replyText: data.replyText || null,
              sender: 'partner',
              isStamp: data.isStamp,
              isRead: true,
              timestamp: Date.now()
            };
            saveAndRenderNewMessage(msgObj);
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

function toggleStampPalette() {
  const palette = document.getElementById('stamp-palette');
  palette.classList.toggle('hidden');
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
  renderAllMessages();
  connectToPartner();
  updateBadge(0);
}

function hideToEditor() {
  document.getElementById('secret-screen').classList.add('hidden');
  document.getElementById('editor-screen').classList.remove('hidden');
  document.getElementById('stamp-palette').classList.add('hidden');
  cancelReply();
}

if (window.DeviceOrientationEvent) {
  window.addEventListener('deviceorientation', (event) => {
    if (event.beta < -150 || event.beta > 150) {
      hideToEditor();
    }
  });
}
