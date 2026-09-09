// ================= メインUI・P2P通信・Gboard学習抑止 =================

let peer = null;
let activeConn = null;
let activeCall = null;
let localAudioStream = null;
let reconnectTimer = null;
let wakeLock = null;

let currentReplyTo = null;
let selectedMsgTarget = { text: '', id: '' };

// 複数選択削除用状態管理
let isSelectMode = false;
let selectedMsgIds = new Set();

function getStoredMessages() {
  try {
    return JSON.parse(localStorage.getItem('chat_history') || '[]');
  } catch (e) {
    return [];
  }
}

// 既読後1時間経過したメッセージを自動消去
function saveStoredMessages(messages) {
  const now = Date.now();
  const oneHour = 1 * 60 * 60 * 1000;
  
  messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const filtered = messages.filter(m => {
    if (m.isRead && m.readAt && (now - m.readAt) > oneHour) {
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
  if (typeof registerServiceWorkerAndPush === 'function') {
    registerServiceWorkerAndPush();
  }

  const codeArea = document.getElementById('code-area');
  if (codeArea) {
    setTimeout(() => {
      codeArea.focus();
      codeArea.setSelectionRange(codeArea.value.length, codeArea.value.length);
    }, 100);
  }

  // チャット入力欄のGboard学習抑止（シークレット入力化）
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.setAttribute('autocomplete', 'new-password');
    chatInput.setAttribute('autocorrect', 'off');
    chatInput.setAttribute('autocapitalize', 'off');
    chatInput.setAttribute('spellcheck', 'false');
    chatInput.setAttribute('data-form-type', 'other');
    chatInput.setAttribute('data-lpignore', 'true');

    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });
  }

  if (sessionStorage.getItem('open_secret_screen') === 'true') {
    switchToSecret();
  }
});

// 画面消灯やバックグラウンド移行時の自動保護
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
    updateOnlineUI(false);
    scheduleReconnect();
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    updateOnlineUI(false);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToPartner();
  }, 2000);
}

function connectToPartner() {
  if (activeConn && activeConn.open) {
    updateOnlineUI(true);
    return;
  }
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
  updateOnlineUI(true);
  renderAllMessages();

  activeConn.on('data', (data) => {
    if (data.type === 'chat') {
      const secretScreen = document.getElementById('secret-screen');
      const isSecretActive = secretScreen && !secretScreen.classList.contains('hidden');
      
      const msgObj = {
        id: data.id,
        text: data.text,
        replyText: data.replyText || null,
        fileData: data.fileData || null,
        fileName: data.fileName || null,
        fileType: data.fileType || null,
        sender: 'partner',
        isStamp: data.isStamp,
        isRead: isSecretActive,
        readAt: isSecretActive ? Date.now() : null,
        timestamp: data.timestamp || Date.now()
      };
      saveAndRenderNewMessage(msgObj);
      
      if (isSecretActive) {
        activeConn.send({ type: 'read_ack', id: data.id });
      }
    } else if (data.type === 'read_ack') {
      markMyMessagesAsRead(data.id);
    } else if (data.type === 'read_ack_all') {
      markMyMessagesAsRead();
    } else if (data.type === 'delete') {
      deleteLocalMessage(data.id);
    } else if (data.type === 'delete_multiple') {
      if (Array.isArray(data.ids)) {
        data.ids.forEach(id => deleteLocalMessage(id));
      }
    }
  });

  activeConn.on('close', () => {
    updateOnlineUI(false);
    activeConn = null;
    scheduleReconnect();
  });
}

function updateOnlineUI(isOnline) {
  const roleDisplay = document.getElementById('role-display');
  if (!roleDisplay) return;

  if (isOnline) {
    roleDisplay.style.cssText = 'background:#0d6efd;color:#ffffff;padding:4px 10px;border-radius:4px;font-weight:bold;display:inline-block;border:2px solid #ffca28;';
    roleDisplay.innerText = `Me: ${myRole} | ⚡ ONLINE［リアルタイム通信］`;
  } else {
    roleDisplay.style.cssText = 'background:#495057;color:#e0e0e0;padding:4px 10px;border-radius:4px;font-weight:normal;display:inline-block;border:1px solid #6c757d;';
    roleDisplay.innerText = `Me: ${myRole} | 📴 OFFLINE［非同期DBモード］`;
  }
}

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
// Commit Changes ボタン処理
async function showDummyCommitToast() {
  const toast = document.getElementById('dummy-toast');
  if (toast) {
    toast.innerText = '[SUCCESS] Commit applied to main branch.';
    toast.classList.remove('hidden');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 2000);
  }

  if (GITHUB_CONFIG.getToken()) {
    await fetchOfflineMessages();
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
  
  list.scrollTop = list.scrollHeight;
  updateUnreadBadgeCount();
}

function saveAndRenderNewMessage(msgObj) {
  const messages = getStoredMessages();
  if (!messages.some(m => m.id === msgObj.id)) {
    messages.push(msgObj);
    saveStoredMessages(messages);
  }
  
  renderAllMessages();
}

function renderSingleMessage(m) {
  const list = document.getElementById('message-list');
  if (!list) return;

  const existing = document.querySelector(`[data-id="${m.id}"]`);
  if (existing) {
    if (m.sender === 'me') {
      const statusElem = existing.querySelector('.read-status-text');
      if (statusElem) statusElem.innerText = m.isRead ? '既読' : '未読';
    }
    return;
  }

  const msgContainer = document.createElement('div');
  const className = m.sender === 'me' ? 'my-msg' : 'partner-msg';
  
  msgContainer.className = `msg ${className} ${m.isStamp ? 'stamp-msg' : ''}`;
  msgContainer.setAttribute('data-id', m.id);

  let html = '';
  if (m.replyText) {
    html += `<div class="reply-quote">↩ ${escapeHtml(m.replyText)}</div>`;
  }

  if (m.fileData) {
    if (m.fileType && m.fileType.startsWith('image/')) {
      html += `<div class="file-attachment"><img src="${m.fileData}" style="max-width:100%;border-radius:8px;margin-bottom:4px;cursor:pointer;" onclick="downloadFile('${m.fileData}', '${escapeHtml(m.fileName)}')"/><br/><a href="${m.fileData}" download="${escapeHtml(m.fileName)}" style="color:#64b5f6;font-size:12px;text-decoration:underline;">📥 ${escapeHtml(m.fileName)} を保存</a></div>`;
    } else {
      html += `<div class="file-attachment"><a href="${m.fileData}" download="${escapeHtml(m.fileName)}" style="color:#64b5f6;font-size:14px;text-decoration:underline;">📎 📥 ${escapeHtml(m.fileName)} をダウンロード</a></div>`;
    }
  } else {
    html += `<span class="msg-text">${escapeHtml(m.text)}</span>`;
  }
  
  html += `<div class="msg-meta">`;
  if (m.sender === 'me') {
    html += `<span class="read-status-text">${m.isRead ? '既読' : '未読'}</span>`;
  }
  html += `<span class="msg-time">${formatTime(m.timestamp)}</span>`;
  html += `</div>`;

  msgContainer.innerHTML += html;
  list.appendChild(msgContainer);
}

function downloadFile(dataUrl, fileName) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

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
    document.querySelectorAll('.my-msg').forEach(elem => {
      const msgId = elem.getAttribute('data-id');
      if (!targetId || msgId === targetId) {
        const statusElem = elem.querySelector('.read-status-text');
        if (statusElem) statusElem.innerText = '既読';
      }
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

function cancelReply() {
  currentReplyTo = null;
  const preview = document.getElementById('reply-preview');
  if (preview) preview.classList.add('hidden');
}

// 通話・画面制御
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
  activeCall = call;
  showCallBar(true);

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
  callBar.style.display = show ? 'flex' : 'none';
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
