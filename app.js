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

// 既読後1時間経過したメッセージを自動消去（24時間から1時間に変更）
function saveStoredMessages(messages) {
  const now = Date.now();
  const oneHour = 1 * 60 * 60 * 1000; // 1時間（ミリ秒）
  
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
      const secretScreen = document.getElementById('secret-screen');
      const isSecretActive = secretScreen && !secretScreen.classList.contains('hidden');
      
      const msgObj = {
        id: data.id,
        text: data.text,
        replyText: data.replyText || null,
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

// Commit Changes ボタン（ダミー成功トースト＋未読高速チェック）
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

// メッセージ非表示 / 表示切替
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

// 複数選択削除用UIバーの生成・取得
function getOrCreateSelectBar() {
  let bar = document.getElementById('select-delete-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'select-delete-bar';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;width:100%;height:54px;background:#1e1e1e;color:#fff;display:none;align-items:center;justify-content:space-between;padding:0 16px;z-index:3500;border-top:1px solid #333;box-sizing:border-box;';
    bar.innerHTML = `
      <button id="btn-cancel-select" onclick="exitSelectMode()" style="background:#444;color:#fff;border:none;padding:8px 14px;border-radius:4px;font-size:13px;cursor:pointer;">キャンセル</button>
      <span id="select-count-text" style="font-size:14px;font-weight:bold;">0件選択中</span>
      <button id="btn-confirm-select-delete" onclick="deleteSelectedMessages()" style="background:#dc3545;color:#fff;border:none;padding:8px 14px;border-radius:4px;font-size:13px;font-weight:bold;cursor:pointer;">削除</button>
    `;
    document.body.appendChild(bar);
  }
  return bar;
}

function enterSelectMode(initialMsgId = null) {
  isSelectMode = true;
  selectedMsgIds.clear();
  if (initialMsgId) {
    selectedMsgIds.add(initialMsgId);
  }

  const bar = getOrCreateSelectBar();
  bar.style.display = 'flex';

  document.querySelectorAll('.msg').forEach(msgElem => {
    msgElem.classList.add('select-mode-active');
    const msgId = msgElem.getAttribute('data-id');
    
    let checkbox = msgElem.querySelector('.msg-checkbox');
    if (!checkbox) {
      checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'msg-checkbox';
      checkbox.style.cssText = 'margin-right:8px;transform:scale(1.2);cursor:pointer;';
      msgElem.insertBefore(checkbox, msgElem.firstChild);
    }
    
    checkbox.checked = selectedMsgIds.has(msgId);
    
    msgElem.onclick = (e) => {
      if (!isSelectMode) return;
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
      }
      if (checkbox.checked) {
        selectedMsgIds.add(msgId);
        msgElem.classList.add('msg-selected');
      } else {
        selectedMsgIds.delete(msgId);
        msgElem.classList.remove('msg-selected');
      }
      updateSelectCountText();
    };
  });

  updateSelectCountText();
}

function updateSelectCountText() {
  const countText = document.getElementById('select-count-text');
  if (countText) {
    countText.innerText = `${selectedMsgIds.size}件選択中`;
  }
}

function exitSelectMode() {
  isSelectMode = false;
  selectedMsgIds.clear();

  const bar = document.getElementById('select-delete-bar');
  if (bar) bar.style.display = 'none';

  document.querySelectorAll('.msg').forEach(msgElem => {
    msgElem.classList.remove('select-mode-active', 'msg-selected');
    msgElem.onclick = null;
    const checkbox = msgElem.querySelector('.msg-checkbox');
    if (checkbox) checkbox.remove();
  });
}

function deleteSelectedMessages() {
  if (selectedMsgIds.size === 0) {
    alert('削除するメッセージを選択してください');
    return;
  }

  if (confirm(`選択した ${selectedMsgIds.size} 件のメッセージを削除しますか？`)) {
    const idsToDelete = Array.from(selectedMsgIds);
    idsToDelete.forEach(id => deleteLocalMessage(id));

    if (activeConn && activeConn.open) {
      activeConn.send({ type: 'delete_multiple', ids: idsToDelete });
    }

    exitSelectMode();
  }
}

// 長押し ＆ 横スライド（スワイプ）削除処理
function attachLongPressAndSwipeMenu(msgElement, msgText, msgId) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let currentY = 0;
  let isSwiping = false;

  const openSheet = () => {
    if (isSelectMode) return;
    selectedMsgTarget = { text: msgText, id: msgId };
    const sheet = document.getElementById('action-sheet');
    if (sheet) sheet.classList.remove('hidden');
  };

  msgElement.addEventListener('touchstart', (e) => {
    if (isSelectMode) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    currentX = startX;
    currentY = startY;
    isSwiping = false;
    msgElement.style.transition = 'none';
    timer = setTimeout(openSheet, 500);
  }, { passive: true });

  msgElement.addEventListener('touchmove', (e) => {
    if (isSelectMode) return;
    currentX = e.touches[0].clientX;
    currentY = e.touches[0].clientY;
    const diffX = currentX - startX;
    const diffY = currentY - startY;

    if (Math.abs(diffX) > Math.abs(diffY) && diffX < -10) {
      clearTimeout(timer);
      isSwiping = true;
    }

    if (isSwiping && diffX < 0 && diffX > -120) {
      msgElement.style.transform = `translateX(${diffX}px)`;
    }
  }, { passive: true });

  msgElement.addEventListener('touchend', () => {
    if (isSelectMode) return;
    clearTimeout(timer);
    msgElement.style.transition = 'transform 0.2s ease';

    const diffX = currentX - startX;

    if (isSwiping && diffX < -60) {
      msgElement.style.transform = 'translateX(-100px)';
      setTimeout(() => {
        if (confirm("このメッセージを削除しますか？")) {
          deleteMessage(msgId);
        } else {
          msgElement.style.transform = 'translateX(0)';
        }
      }, 50);
    } else {
      msgElement.style.transform = 'translateX(0)';
    }

    startX = 0;
    startY = 0;
    currentX = 0;
    currentY = 0;
    isSwiping = false;
  });

  msgElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!isSelectMode) openSheet();
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

function handleMenuSelectDelete() {
  closeActionSheet();
  enterSelectMode(selectedMsgTarget.id);
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

  if (isSelectMode) {
    msgContainer.classList.add('select-mode-active');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'msg-checkbox';
    checkbox.style.cssText = 'margin-right:8px;transform:scale(1.2);cursor:pointer;';
    checkbox.checked = selectedMsgIds.has(m.id);
    if (checkbox.checked) msgContainer.classList.add('msg-selected');
    
    msgContainer.appendChild(checkbox);
    
    msgContainer.onclick = (e) => {
      if (!isSelectMode) return;
      if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
      if (checkbox.checked) {
        selectedMsgIds.add(m.id);
        msgContainer.classList.add('msg-selected');
      } else {
        selectedMsgIds.delete(m.id);
        msgContainer.classList.remove('msg-selected');
      }
      updateSelectCountText();
    };
  }

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

  msgContainer.innerHTML += html;

  attachLongPressAndSwipeMenu(msgContainer, m.text, m.id);
  list.appendChild(msgContainer);
  list.scrollTop = list.scrollHeight;
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
    const res = await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues?labels=offline-msg&state=open&per_page=100`, {
      headers: { 'Authorization': `token ${token}` }
    });
    
    if (!res.ok) return;
    const issues = await res.json();
    
    if (Array.isArray(issues)) {
      const secretScreen = document.getElementById('secret-screen');
      const isSecretActive = secretScreen && !secretScreen.classList.contains('hidden');
      const closePromises = [];

      issues.forEach(issue => {
        try {
          const data = JSON.parse(issue.body);
          if (data && data.target === myRole) {
            const msgObj = {
              id: data.id,
              text: data.text,
              replyText: data.replyText || null,
              sender: 'partner',
              isStamp: data.isStamp,
              isRead: isSecretActive,
              readAt: isSecretActive ? Date.now() : null,
              timestamp: data.timestamp || Date.now()
            };
            saveAndRenderNewMessage(msgObj);
            
            if (isSecretActive) {
              closePromises.push(closeGitHubIssue(issue.number, token));
            }
          }
        } catch (e) {
          console.error('Issueパースエラー:', e);
        }
      });

      if (closePromises.length > 0) {
        Promise.all(closePromises).catch(err => console.error('一括Issueクローズエラー:', err));
      }
    }

    updateUnreadBadgeCount();
  } catch (err) {
    console.error('未読取得エラー:', err);
  }
}

async function closeGitHubIssue(issueNumber, token) {
  try {
    await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'P2P-Chat-App'
      },
      body: JSON.stringify({ state: 'closed' })
    });
  } catch(e) {
    console.error('Issueクローズエラー:', e);
  }
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
