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

const SECRET_PIN = '904900'; // 秘密のアクセスコード

const savedRole = localStorage.getItem('user_role');
const urlParams = new URLSearchParams(window.location.search);
const urlRole = urlParams.get('user') === 'b' ? 'user_b' : (urlParams.get('user') === 'a' ? 'user_a' : null);

const myRole = savedRole || urlRole || 'user_a';
const targetRole = myRole === 'user_a' ? 'user_b' : 'user_a';

let peer = null;
let activeConn = null;
let activeCall = null;
let localAudioStream = null;
let reconnectTimer = null;
let wakeLock = null;

let currentReplyTo = null;
let selectedMsgTarget = { text: '', id: '' };

function getStoredMessages() {
  try {
    return JSON.parse(localStorage.getItem('chat_history') || '[]');
  } catch (e) {
    return [];
  }
}

// 既読後24時間経過したメッセージを自動消去
function saveStoredMessages(messages) {
  const now = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;
  
  const filtered = messages.filter(m => {
    if (m.isRead && m.readAt && (now - m.readAt) > twentyFourHours) {
      return false;
    }
    return true;
  });

  try {
    localStorage.setItem('chat_history', JSON.stringify(filtered));
  } catch(e) {}
  return filtered;
}

// 初期化処理
window.addEventListener('DOMContentLoaded', () => {
  setupJSIconTrigger();
  initPeer();

  const codeArea = document.getElementById('code-area');
  if (codeArea) {
    setTimeout(() => {
      codeArea.focus();
      codeArea.setSelectionRange(codeArea.value.length, codeArea.value.length);
    }, 100);
  }

  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });
  }

  if (sessionStorage.getItem('open_secret_screen') === 'true') {
    switchToSecret();
  }
});

// 画面消灯（スリープ）やバックグラウンド移行時に表画面へ強制復帰
document.addEventListener('visibilitychange', () => {
  if (document.hidden || document.visibilityState === 'hidden') {
    hideToEditor();
  }
});

window.addEventListener('pagehide', () => {
  hideToEditor();
});

function initPeer() {
  if (peer && !peer.destroyed) return;

  peer = new Peer(myRole);

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
    if (confirm('📞 通話の着信があります。応答しますか？')) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localAudioStream = stream;
        call.answer(stream);
        handleCallStream(call);
      } catch (e) {
        alert('マイクのアクセス許可が必要です');
      }
    }
  });

  peer.on('disconnected', () => {
    scheduleReconnect();
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToPartner();
  }, 3000);
}

function connectToPartner() {
  if (activeConn && activeConn.open) return;
  if (!peer || peer.disconnected) {
    try { peer.reconnect(); } catch(e) {}
  }
  try {
    const conn = peer.connect(targetRole, { reliable: true });
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

  activeConn.on('data', (data) => {
    if (data.type === 'chat') {
      const list = document.getElementById('message-list');
      const isVisible = list && !list.classList.contains('hidden-messages');
      
      const msgObj = {
        id: data.id,
        text: data.text,
        replyText: data.replyText || null,
        sender: 'partner',
        isStamp: data.isStamp,
        isRead: isVisible,
        readAt: isVisible ? Date.now() : null,
        timestamp: data.timestamp || Date.now()
      };
      saveAndRenderNewMessage(msgObj);
      
      if (isVisible) {
        activeConn.send({ type: 'read_ack', id: data.id });
      }
    } else if (data.type === 'read_ack') {
      markMyMessagesAsRead(data.id);
    } else if (data.type === 'read_ack_all') {
      markMyMessagesAsRead();
    } else if (data.type === 'delete') {
      deleteLocalMessage(data.id);
    }
  });

  activeConn.on('close', () => {
    if (statusDot) statusDot.style.background = '#777';
    if (roleDisplay) roleDisplay.innerText = `Me: ${myRole} | Partner (Offline)`;
    activeConn = null;
    scheduleReconnect();
  });
}

// 青い「JS」アイコンタップ判定（3回連打＋英語認証ダイアログ）
function setupJSIconTrigger() {
  const icon = document.getElementById('js-icon-trigger');
  if (!icon) return;

  let tapCount = 0;
  let tapTimer = null;

  const handleTap = (e) => {
    e.preventDefault();
    tapCount++;

    if (tapTimer) clearTimeout(tapTimer);

    if (tapCount >= 3) {
      tapCount = 0;
      
      setTimeout(() => {
        const inputPin = prompt('[System Maintenance]\nSecurity Verification Required:\n\nEnter Developer Authorization Code:');
        if (inputPin === SECRET_PIN) {
          switchToSecret();
        } else if (inputPin !== null) {
          alert('Access Denied: Invalid Authorization Code.');
        }
      }, 50);
    } else {
      tapTimer = setTimeout(() => {
        tapCount = 0;
      }, 800);
    }
  };

  icon.addEventListener('click', handleTap);
}

// Commit Changes ボタン（ダミー成功トースト）
function showDummyCommitToast() {
  const toast = document.getElementById('dummy-toast');
  if (toast) {
    toast.innerText = '[SUCCESS] Commit applied to main branch.';
    toast.classList.remove('hidden');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 2000);
  }
}
function clearPartnerUnreadState() {
  let messages = getStoredMessages();
  let updated = false;
  const now = Date.now();

  messages = messages.map(m => {
    if (m.sender === 'partner' && !m.isRead) {
      m.isRead = true;
      m.readAt = now;
      updated = true;
    }
    return m;
  });

  if (updated) {
    saveStoredMessages(messages);
  }
}

function updateUnreadBadgeCount() {
  const messages = saveStoredMessages(getStoredMessages());
  const unreadCount = messages.filter(m => m.sender === 'partner' && !m.isRead).length;
  
  const badgeElem = document.getElementById('unread-badge');
  if (badgeElem) {
    if (unreadCount > 0) {
      badgeElem.innerText = unreadCount;
      badgeElem.classList.remove('hidden');
    } else {
      badgeElem.classList.add('hidden');
    }
  }

  const commitBtn = document.querySelector('.btn-commit');
  if (commitBtn) {
    if (unreadCount > 0) {
      commitBtn.innerText = `Commit Changes (${unreadCount})`;
    } else {
      commitBtn.innerText = 'Commit Changes';
    }
  }

  updateBadge(unreadCount);
}

// ================= メッセージ非表示 / 表示切替 =================
function toggleMessageVisibility() {
  const list = document.getElementById('message-list');
  const inputArea = document.getElementById('chat-input-area') || document.getElementById('input-area');
  const btn = document.querySelector('.btn-show');
  
  if (!list) return;

  if (list.classList.contains('hidden-messages')) {
    list.classList.remove('hidden-messages');
    if (inputArea) {
      inputArea.classList.remove('hidden-input');
      inputArea.style.display = '';
    }
    if (btn) btn.innerText = '🙈';
    
    clearPartnerUnreadState();
    if (activeConn && activeConn.open) {
      activeConn.send({ type: 'read_ack_all' });
    }
  } else {
    list.classList.add('hidden-messages');
    if (inputArea) {
      inputArea.classList.add('hidden-input');
    }
    if (btn) btn.innerText = '👁️';
    const palette = document.getElementById('stamp-palette');
    if (palette) palette.classList.add('hidden');
  }
  updateUnreadBadgeCount();
}

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
    input.style.height = 'auto';
    const palette = document.getElementById('stamp-palette');
    if (palette) palette.classList.add('hidden');
    renderAllMessages();
    fetchOfflineMessages();
    return;
  }

  await dispatchMessage(text, false);
  input.value = '';
  input.style.height = 'auto';
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
  const now = Date.now();
  
  // 送信時は相手の確認通知を受けるまで厳格に isRead = false に固定
  const msgObj = {
    id: msgId,
    text: text,
    replyText: currentReplyTo ? currentReplyTo.text : null,
    sender: 'me',
    isStamp: isStamp,
    isRead: false,
    readAt: null,
    timestamp: now
  };

  saveAndRenderNewMessage(msgObj);

  if (isOnline) {
    activeConn.send({ 
      type: 'chat', 
      text: text, 
      replyText: msgObj.replyText, 
      isStamp: isStamp, 
      id: msgId,
      timestamp: now
    });
  } else {
    await saveMessageToGitHub(text, isStamp, msgId, msgObj.replyText, now);
  }
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return timeStr;
  } else {
    return `${date.getMonth() + 1}/${date.getDate()} ${timeStr}`;
  }
}

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
  updateUnreadBadgeCount();
}

function saveAndRenderNewMessage(msgObj) {
  const messages = getStoredMessages();
  if (!messages.some(m => m.id === msgObj.id)) {
    messages.push(msgObj);
    saveStoredMessages(messages);
  }
  renderSingleMessage(msgObj);
  updateUnreadBadgeCount();
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
    html += `<div class="reply-quote">↩ ${escapeHtml(m.replyText)}</div>`;
  }
  html += `<span class="msg-text">${escapeHtml(m.text)}</span>`;
  
  html += `<div class="msg-meta">`;
  if (m.sender === 'me') {
    html += `<span class="read-status-text">${m.isRead ? '既読' : '未読'}</span>`;
  }
  html += `<span class="msg-time">${formatTime(m.timestamp)}</span>`;
  html += `</div>`;

  msgContainer.innerHTML = html;

  attachLongPressMenu(msgContainer, m.text, m.id);
  list.appendChild(msgContainer);
  list.scrollTop = list.scrollHeight;
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// 相手からの既読通知（read_ack）を受け取った時だけ「既読」状態へ変更する
function markMyMessagesAsRead(targetId = null) {
  let messages = getStoredMessages();
  let updated = false;
  const now = Date.now();

  messages = messages.map(m => {
    if (m.sender === 'me' && (!targetId || m.id === targetId)) {
      if (!m.isRead) {
        m.isRead = true;
        m.readAt = now;
        updated = true;
      }
    }
    return m;
  });

  if (updated) {
    saveStoredMessages(messages);
    document.querySelectorAll('.my-msg .read-status-text').forEach(elem => {
      elem.innerText = '既読';
    });
  }
  updateUnreadBadgeCount();
}

function deleteLocalMessage(msgId) {
  let messages = getStoredMessages();
  messages = messages.filter(m => m.id !== msgId);
  saveStoredMessages(messages);
  const elem = document.querySelector(`[data-id="${msgId}"]`);
  if (elem) elem.remove();
  updateUnreadBadgeCount();
}

function deleteMessage(msgId) {
  deleteLocalMessage(msgId);
  if (activeConn && activeConn.open) {
    activeConn.send({ type: 'delete', id: msgId });
  }
}

async function saveMessageToGitHub(text, isStamp, msgId, replyText = null, timestamp = Date.now()) {
  const token = GITHUB_CONFIG.getToken();
  if (!token) return;

  const bodyData = JSON.stringify({
    id: msgId,
    sender: myRole,
    target: targetRole,
    text: text,
    replyText: replyText,
    isStamp: isStamp,
    timestamp: timestamp
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
            const list = document.getElementById('message-list');
            const isVisible = list && !list.classList.contains('hidden-messages');

            const msgObj = {
              id: data.id,
              text: data.text,
              replyText: data.replyText || null,
              sender: 'partner',
              isStamp: data.isStamp,
              isRead: isVisible,
              readAt: isVisible ? Date.now() : null,
              timestamp: data.timestamp || Date.now()
            };
            saveAndRenderNewMessage(msgObj);
            count++;
            closeGitHubIssue(issue.number, token);
          }
        } catch (e) {}
      });
    }

    updateUnreadBadgeCount();
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
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (err) {
    console.log('WakeLock Error:', err);
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().then(() => {
      wakeLock = null;
    });
  }
}

async function startCall() {
  if (!activeConn || !activeConn.open) {
    alert('相手がオンラインではありません');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localAudioStream = stream;
    const call = peer.call(targetRole, stream);
    handleCallStream(call);
  } catch (err) {
    alert('マイクのアクセス許可が必要です');
  }
}

function handleCallStream(call) {
  activeCall = call;
  showCallBar(true);
  requestWakeLock();

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

  call.on('close', () => {
    endCallUI();
  });
}

function endCall() {
  if (activeCall) {
    activeCall.close();
    activeCall = null;
  }
  endCallUI();
}

function endCallUI() {
  releaseWakeLock();
  if (localAudioStream) {
    localAudioStream.getTracks().forEach(track => track.stop());
    localAudioStream = null;
  }
  const audio = document.getElementById('remote-audio');
  if (audio) {
    audio.srcObject = null;
  }
  showCallBar(false);
}

function showCallBar(show) {
  let callBar = document.getElementById('call-bar');
  if (!callBar) {
    callBar = document.createElement('div');
    callBar.id = 'call-bar';
    callBar.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:40px;background:#28a745;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 16px;z-index:3000;font-size:14px;font-weight:bold;';
    callBar.innerHTML = '<span>📞 通話中...</span><button onclick="endCall()" style="background:#dc3545;color:#fff;border:none;padding:4px 12px;border-radius:4px;font-weight:bold;cursor:pointer;">📵 終了</button>';
    document.body.appendChild(callBar);
  }
  if (show) {
    callBar.style.display = 'flex';
  } else {
    callBar.style.display = 'none';
  }
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
  const inputArea = document.getElementById('chat-input-area') || document.getElementById('input-area');
  const btn = document.querySelector('.btn-show');
  
  if (list) list.classList.add('hidden-messages');
  if (inputArea) inputArea.classList.add('hidden-input');
  if (btn) btn.innerText = '👁️';

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
  updateUnreadBadgeCount();
}

if (window.DeviceOrientationEvent) {
  window.addEventListener('deviceorientation', (event) => {
    if (event.beta < -150 || event.beta > 150) {
      hideToEditor();
    }
  });
}
