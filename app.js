// ================= 設定領域 =================
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

const savedRole = localStorage.getItem('user_role');
const urlParams = new URLSearchParams(window.location.search);
const urlRole = urlParams.get('user') === 'b' ? 'user_b' : (urlParams.get('user') === 'a' ? 'user_a' : null);

const myRole = savedRole || urlRole || 'user_a';
const targetRole = myRole === 'user_a' ? 'user_b' : 'user_a';

const peer = new Peer(myRole);
let activeConn = null;
let activeCall = null;

let currentReplyTo = null;
let selectedMsgTarget = { text: '', id: '' };

function getStoredMessages() {
  try {
    return JSON.parse(localStorage.getItem('chat_history') || '[]');
  } catch (e) {
    return [];
  }
}

function saveStoredMessages(messages) {
  const now = Date.now();
  const threeDays = 3 * 24 * 60 * 60 * 1000;
  const filtered = messages.filter(m => (now - m.timestamp) < threeDays);
  try {
    localStorage.setItem('chat_history', JSON.stringify(filtered));
  } catch(e) {}
  return filtered;
}

// 初期化処理
window.addEventListener('DOMContentLoaded', () => {
  setupJSIconTrigger();
  // 起動時に最終行へカーソルを合わせる
  const codeArea = document.getElementById('code-area');
  if (codeArea) {
    codeArea.focus();
    codeArea.setSelectionRange(codeArea.value.length, codeArea.value.length);
  }

  if (sessionStorage.getItem('open_secret_screen') === 'true') {
    switchToSecret();
  }
});

peer.on('open', (id) => {
  connectToPartner();
  if (GITHUB_CONFIG.getToken()) {
    fetchOfflineMessages();
  }
});

peer.on('connection', (conn) => {
  activeConn = conn;
  setupConnectionEvents();
});

peer.on('call', async (call) => {
  if (confirm('通話の着信があります。応答しますか？')) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      call.answer(stream);
      handleStream(call);
    } catch (e) {
      alert('マイクのアクセス許可が必要です');
    }
  }
});

function connectToPartner() {
  if (activeConn && activeConn.open) return;
  try {
    const conn = peer.connect(targetRole);
    conn.on('open', () => {
      activeConn = conn;
      setupConnectionEvents();
    });
  } catch (e) {
    console.error('Connection error:', e);
  }
}

function setupConnectionEvents() {
  const statusDot = document.querySelector('.status-dot');
  const roleDisplay = document.getElementById('role-display');
  
  if (statusDot) statusDot.style.background = '#4caf50';
  if (roleDisplay) roleDisplay.innerText = `Me: ${myRole} | Partner (Online)`;

  renderAllMessages();

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
    if (roleDisplay) roleDisplay.innerText = `Me: ${myRole} | Partner (Offline)`;
    activeConn = null;
  });
}

// ================= 青い「JS」アイコン 1回タップで隠し画面起動 =================
function setupJSIconTrigger() {
  const icon = document.getElementById('js-icon-trigger');
  if (!icon) return;

  icon.addEventListener('click', (e) => {
    e.preventDefault();
    switchToSecret();
  });
}

function showDummyCommitToast() {
  const toast = document.getElementById('dummy-toast');
  if (!toast) return;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 1500);
}

// ================= メッセージ非表示 / 表示切替（アイコンのみ対応） =================
function toggleMessageVisibility() {
  const list = document.getElementById('message-list');
  const inputArea = document.getElementById('input-area');
  const btn = document.querySelector('.btn-show');
  
  if (!list) return;

  if (list.classList.contains('hidden-messages')) {
    list.classList.remove('hidden-messages');
    if (inputArea) inputArea.classList.remove('hidden-input');
    if (btn) btn.innerText = '🙈'; // アイコンのみに変更
  } else {
    list.classList.add('hidden-messages');
    if (inputArea) inputArea.classList.add('hidden-input');
    if (btn) btn.innerText = '👁️'; // アイコンのみに変更
    const palette = document.getElementById('stamp-palette');
    if (palette) palette.classList.add('hidden');
  }
}

// ================= メッセージ送信 =================
async function sendMsg() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  if (text.toLowerCase() === 'reload') {
    sessionStorage.setItem('open_secret_screen', 'true');
    location.reload(true);
    return;
  }

  if (text.toLowerCase() === 'set_b') {
    localStorage.setItem('user_role', 'user_b');
    sessionStorage.setItem('open_secret_screen', 'true');
    alert('ユーザー役割を user_b に固定しました！');
    location.reload(true);
    return;
  }
  if (text.toLowerCase() === 'set_a') {
    localStorage.setItem('user_role', 'user_a');
    sessionStorage.setItem('open_secret_screen', 'true');
    alert('ユーザー役割を user_a に固定しました！');
    location.reload(true);
    return;
  }

  if (text.startsWith('ghp_')) {
    try {
      localStorage.setItem('gh_token', text);
      alert('🔑 通信キーを保存しました！');
    } catch(e) {
      alert('保存エラー: プライベートブラウジングを解除してください');
    }
    input.value = '';
    const palette = document.getElementById('stamp-palette');
    if (palette) palette.classList.add('hidden');
    renderAllMessages();
    fetchOfflineMessages();
    return;
  }

  await dispatchMessage(text, false);
  input.value = '';
  cancelReply();
  const palette = document.getElementById('stamp-palette');
  if (palette) palette.classList.add('hidden');
}

async function sendStamp(emoji) {
  await dispatchMessage(emoji, true);
  cancelReply();
  const palette = document.getElementById('stamp-palette');
  if (palette) palette.classList.add('hidden');
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

// ================= タップ操作メニューシート =================
function attachLongPressMenu(msgElement, msgText, msgId) {
  let timer = null;

  const openSheet = () => {
    selectedMsgTarget = { text: msgText, id: msgId };
    const sheet = document.getElementById('action-sheet');
    if (sheet) sheet.classList.remove('hidden');
  };

  msgElement.addEventListener('touchstart', () => {
    timer = setTimeout(openSheet, 500);
  }, { passive: true });

  msgElement.addEventListener('touchend', () => clearTimeout(timer));
  msgElement.addEventListener('touchmove', () => clearTimeout(timer));

  msgElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openSheet();
  });
}

function closeActionSheet() {
  const sheet = document.getElementById('action-sheet');
  if (sheet) sheet.classList.add('hidden');
}

function handleMenuCopy() {
  if (selectedMsgTarget.text) {
    navigator.clipboard.writeText(selectedMsgTarget.text);
  }
  closeActionSheet();
}

function handleMenuReply() {
  currentReplyTo = { text: selectedMsgTarget.text };
  const replyTextElem = document.getElementById('reply-text');
  if (replyTextElem) replyTextElem.innerText = selectedMsgTarget.text;
  const preview = document.getElementById('reply-preview');
  if (preview) preview.classList.remove('hidden');
  closeActionSheet();
}

function handleMenuDelete() {
  if (confirm("このメッセージを削除しますか？")) {
    deleteMessage(selectedMsgTarget.id);
  }
  closeActionSheet();
}

function cancelReply() {
  currentReplyTo = null;
  const preview = document.getElementById('reply-preview');
  if (preview) preview.classList.add('hidden');
}

// ================= 画面描画 =================
function renderAllMessages() {
  const list = document.getElementById('message-list');
  if (!list) return;
  list.innerHTML = '<div class="system-msg">暗号化されたP2P通信が有効です</div>';
  
  const token = GITHUB_CONFIG.getToken();
  if (token) {
    appendSystemMsg('🔑 通信キー：有効（設定済み）');
  } else {
    appendSystemMsg('⚠️ 通信キー未設定：ghp_... を入力してください');
  }

  const messages = saveStoredMessages(getStoredMessages());
  messages.forEach(m => renderSingleMessage(m));
}

function saveAndRenderNewMessage(msgObj) {
  const messages = getStoredMessages();
  if (!messages.some(m => m.id === msgObj.id)) {
    messages.push(msgObj);
    saveStoredMessages(messages);
  }
  renderSingleMessage(msgObj);
}

function renderSingleMessage(m) {
  const list = document.getElementById('message-list');
  if (!list) return;

  if (document.querySelector(`[data-id="${m.id}"]`)) return;

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
  if (palette) palette.classList.toggle('hidden');
}

// ================= 通話・画面制御 =================
async function startCall() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: title => true });
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
  if (!list) return;
  const msg = document.createElement('div');
  msg.className = 'system-msg';
  msg.innerText = text;
  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
}

function switchToSecret() {
  sessionStorage.setItem('open_secret_screen', 'true');
  const editor = document.getElementById('editor-screen');
  const secret = document.getElementById('secret-screen');
  if (editor) editor.classList.add('hidden');
  if (secret) secret.classList.remove('hidden');
  
  const list = document.getElementById('message-list');
  const inputArea = document.getElementById('input-area');
  const btn = document.querySelector('.btn-show');
  
  if (list) list.classList.add('hidden-messages');
  if (inputArea) inputArea.classList.add('hidden-input');
  if (btn) btn.innerText = '👁️'; // アイコンのみ

  const roleDisplay = document.getElementById('role-display');
  const isOnline = activeConn && activeConn.open;
  if (roleDisplay) {
    roleDisplay.innerText = `Me: ${myRole} | Partner (${isOnline ? 'Online' : 'Offline'})`;
  }

  renderAllMessages();
  connectToPartner();
  
  if (GITHUB_CONFIG.getToken()) {
    fetchOfflineMessages();
  }
  
  updateBadge(0);
}

function hideToEditor() {
  sessionStorage.removeItem('open_secret_screen');
  const secret = document.getElementById('secret-screen');
  const editor = document.getElementById('editor-screen');
  if (secret) secret.classList.add('hidden');
  if (editor) editor.classList.remove('hidden');
  
  const palette = document.getElementById('stamp-palette');
  if (palette) palette.classList.add('hidden');
  cancelReply();
}

if (window.DeviceOrientationEvent) {
  window.addEventListener('deviceorientation', (event) => {
    if (event.beta < -150 || event.beta > 150) {
      hideToEditor();
    }
  });
}
