// ================= メインUI・P2P通信・Gboard学習抑止 =================

let peer = null;
let activeConn = null;
let activeCall = null;
let localAudioStream = null;
let isSpeakerphoneEnabled = false;
let reconnectTimer = null;
let wakeLock = null;
let presenceTimer = null;
let partnerIsOnline = false;
let partnerLastOnlineAt = Number(localStorage.getItem('partner_last_online_' + targetRole) || 0);
let partnerOnlineSince = partnerLastOnlineAt;
let ownOnlineSince = 0;
let offlineSyncTimer = null;

let currentReplyTo = null;
let selectedMsgTarget = { text: '', id: '' };

// 複数選択削除用状態管理
let isSelectMode = false;
let selectedMsgIds = new Set();
let longPressTimer = null;

function scrollMessageListToBottom() {
  const list = document.getElementById('message-list');
  if (!list) return;
  requestAnimationFrame(() => {
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  });
}

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

  // 修正(原因2): iOS Safariはローカルストレージの上限がAndroid/PCより厳しいことが多く、
  // 画像添付メッセージが積み重なると QuotaExceededError が発生する。
  // 従来はここを catch(e){} で握りつぶしており、保存に失敗しても気づかず、
  // 「相手には既読/クローズ済みなのに自分の端末には表示され続けない」データ消失が起きていた。
  try {
    localStorage.setItem('chat_history', JSON.stringify(filtered));
    return filtered;
  } catch (e) {
    console.error('localStorage保存エラー、古い添付ファイル付きメッセージを間引いて再試行します:', e);
    // 古い順に、既読済み＋添付ファイル付きのメッセージからfileDataを間引く
    const pruned = filtered
      .slice()
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .map((m) => {
        if (m.fileData && m.isRead) {
          return { ...m, fileData: null, text: m.text || '[添付ファイルは容量超過のため削除されました]' };
        }
        return m;
      });
    try {
      localStorage.setItem('chat_history', JSON.stringify(pruned));
      return pruned;
    } catch (e2) {
      console.error('再試行後も保存に失敗しました:', e2);
      return filtered;
    }
  }
}

// 修正(原因2): GitHubへの保存に失敗したメッセージをUI上で「送信失敗」と分かるようにする
function markMessageAsFailed(msgId) {
  const messages = getStoredMessages();
  const target = messages.find(m => m.id === msgId);
  if (target) {
    target.sendFailed = true;
    saveStoredMessages(messages);
  }
  const elem = document.querySelector(`[data-id="${msgId}"] .read-status-text`);
  if (elem) elem.innerText = '送信失敗';
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
    chatInput.setAttribute('autocomplete', 'off');
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

  updateUnreadBadgeCount();
  startOfflineSync();
});

// 画面消灯やバックグラウンド移行時の自動保護
document.addEventListener('visibilitychange', () => {
  if (document.hidden || document.visibilityState === 'hidden') {
    hideToEditor();
  } else {
    updateUnreadBadgeCount();
    fetchOfflineMessages();
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
  startPresenceHeartbeat();
  renderAllMessages();

  activeConn.on('data', (data) => {
    if (data.type === 'presence') {
      const wasOnline = partnerIsOnline;
      partnerIsOnline = data.online !== false;
      const presenceTime = data.onlineSince || data.lastOnlineAt;
      if (presenceTime) {
        if (!wasOnline || !partnerOnlineSince) partnerOnlineSince = presenceTime;
        partnerLastOnlineAt = presenceTime;
        localStorage.setItem('partner_last_online_' + targetRole, String(partnerLastOnlineAt));
      }
      updateOnlineUI(activeConn && activeConn.open);
    } else if (data.type === 'chat') {
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
        // 修正(原因3): P2Pのack自体が届かない場合の保険として、
        // 対応するGitHub Issueがあれば併せてクローズしておく（ベストエフォート）
        const ghToken = GITHUB_CONFIG.getToken();
        if (ghToken && typeof closeGitHubIssueByMsgId === 'function') {
          closeGitHubIssueByMsgId(data.id, ghToken).catch(() => {});
        }
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
    if (partnerIsOnline) {
      partnerLastOnlineAt = Date.now();
      localStorage.setItem('partner_last_online_' + targetRole, String(partnerLastOnlineAt));
    }
    stopPresenceHeartbeat();
    partnerIsOnline = false;
    partnerOnlineSince = partnerLastOnlineAt;
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
    roleDisplay.innerText = `Me: ${myRole} | ⚡ ONLINE［リアルタイム通信］ | 相手: ${partnerIsOnline ? formatOnlineSince() : formatLastOnline()}`;
  } else {
    roleDisplay.style.cssText = 'background:#495057;color:#e0e0e0;padding:4px 10px;border-radius:4px;font-weight:normal;display:inline-block;border:1px solid #6c757d;';
    roleDisplay.innerText = `Me: ${myRole} | 📴 OFFLINE［非同期DBモード］ | 相手: ${partnerIsOnline ? formatOnlineSince() : formatLastOnline()}`;
  }
}

function formatOnlineSince() {
  if (!partnerOnlineSince) return 'ONLINE';
  return `ONLINE（${formatTime(partnerOnlineSince)}から）`;
}

function formatLastOnline() {
  if (!partnerLastOnlineAt) return '最終オンライン: 不明';
  return `最終オンライン: ${formatTime(partnerLastOnlineAt)}`;
}

function sendPresence() {
  if (activeConn && activeConn.open) {
    if (!ownOnlineSince) ownOnlineSince = Date.now();
    activeConn.send({
      type: 'presence',
      online: true,
      onlineSince: ownOnlineSince,
      lastOnlineAt: ownOnlineSince
    });
  }
}

function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  sendPresence();
  presenceTimer = setInterval(sendPresence, 15000);
}

function stopPresenceHeartbeat() {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
  ownOnlineSince = 0;
}

function startOfflineSync() {
  if (offlineSyncTimer) clearInterval(offlineSyncTimer);
  offlineSyncTimer = setInterval(() => {
    if (GITHUB_CONFIG.getToken()) fetchOfflineMessages();
  }, 15000);
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
    commitBtn.classList.toggle('has-unread', unreadCount > 0);
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
      // 起動時にトークン未設定だった場合も、購読情報をここでGitHubへ共有する
      if (typeof registerServiceWorkerAndPush === 'function') {
        await registerServiceWorkerAndPush();
      }
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
  
  scrollMessageListToBottom();
  updateUnreadBadgeCount();
}

function saveAndRenderNewMessage(msgObj) {
  const messages = getStoredMessages();
  if (!messages.some(m => m.id === msgObj.id)) {
    messages.push(msgObj);
    saveStoredMessages(messages);
  }
  
  renderAllMessages();
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

  const row = document.createElement('div');
  row.className = `msg-row ${m.sender === 'me' ? 'my-row' : 'partner-row'}`;

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
    // 修正(原因4): CSSのwhite-space:pre-wrapだけに依存すると、
    // Service Workerの古いキャッシュが原因でCSS変更が反映されない環境でも改行が消えてしまう。
    // ここで明示的に \n を <br> に変換しておくことで、CSSの状態に関わらず改行を保証する。
    html += `<span class="msg-text">${escapeHtml(m.text).replace(/\n/g, '<br>')}</span>`;
  }
  
  html += `<div class="msg-meta">`;
  if (m.sender === 'me') {
    const statusText = m.sendFailed ? '送信失敗' : (m.isRead ? '既読' : '未読');
    html += `<span class="read-status-text">${statusText}</span>`;
  }
  html += `<span class="msg-time">${formatTime(m.timestamp)}</span>`;
  html += `</div>`;

  msgContainer.innerHTML += html;
  const swipeDelete = document.createElement('button');
  swipeDelete.className = 'swipe-delete-action';
  swipeDelete.type = 'button';
  swipeDelete.innerText = '削除';
  swipeDelete.addEventListener('click', () => deleteMessageWithNotice(m.id));

  row.appendChild(msgContainer);
  row.appendChild(swipeDelete);
  list.appendChild(row);
  setupMessageGestures(msgContainer, row, m);
}

function setupMessageGestures(message, row, messageData) {
  let startX = 0;
  let startY = 0;
  let swiping = false;

  message.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    startX = event.clientX;
    startY = event.clientY;
    swiping = false;
    message.classList.add('swiping');
    longPressTimer = setTimeout(() => {
      message.classList.remove('swiping');
      openMessageMenu(messageData);
    }, 550);
  });

  message.addEventListener('pointermove', (event) => {
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    if (Math.abs(deltaY) > 12 || Math.abs(deltaX) > 12) clearMessageLongPress();
    if (deltaX < -12 && Math.abs(deltaX) > Math.abs(deltaY)) {
      swiping = true;
      message.style.transform = `translateX(${Math.max(deltaX, -86)}px)`;
      row.classList.toggle('swipe-open', deltaX < -44);
    }
  });

  message.addEventListener('pointerup', (event) => {
    clearMessageLongPress();
    message.classList.remove('swiping');
    if (swiping) {
      const deltaX = event.clientX - startX;
      if (deltaX < -44) {
        message.style.transform = 'translateX(-72px)';
        row.classList.add('swipe-open');
      } else {
        closeSwipeRow(message, row);
      }
    }
  });

  message.addEventListener('pointercancel', () => {
    clearMessageLongPress();
    closeSwipeRow(message, row);
  });

  message.addEventListener('click', () => {
    if (isSelectMode) toggleSelectedMessage(messageData.id);
  });

  message.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openMessageMenu(messageData);
  });
}

function clearMessageLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function closeSwipeRow(message, row) {
  message.style.transform = '';
  row.classList.remove('swipe-open');
}

function openMessageMenu(message) {
  selectedMsgTarget = { text: message.text || '', id: message.id };
  const sheet = document.getElementById('action-sheet');
  if (sheet) sheet.classList.remove('hidden');
}

function closeActionSheet() {
  const sheet = document.getElementById('action-sheet');
  if (sheet) sheet.classList.add('hidden');
}

async function handleMenuCopy() {
  const text = selectedMsgTarget.text || '';
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const helper = document.createElement('textarea');
    helper.value = text;
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }
  closeActionSheet();
}

function handleMenuReply() {
  currentReplyTo = { ...selectedMsgTarget };
  const preview = document.getElementById('reply-preview');
  const replyText = document.getElementById('reply-text');
  if (replyText) replyText.innerText = selectedMsgTarget.text || '添付ファイル';
  if (preview) preview.classList.remove('hidden');
  closeActionSheet();
  document.getElementById('chat-input')?.focus();
}

function handleMenuDelete() {
  const id = selectedMsgTarget.id;
  closeActionSheet();
  if (id && confirm('このメッセージを削除しますか？')) deleteMessageWithNotice(id);
}

function handleMenuSelectDelete() {
  isSelectMode = true;
  selectedMsgIds = new Set([selectedMsgTarget.id]);
  closeActionSheet();
  updateSelectionUI();
}

function toggleSelectedMessage(id) {
  if (!isSelectMode) return;
  if (selectedMsgIds.has(id)) selectedMsgIds.delete(id);
  else selectedMsgIds.add(id);
  updateSelectionUI();
}

function updateSelectionUI() {
  document.querySelectorAll('.msg[data-id]').forEach((message) => {
    message.classList.toggle('selected', selectedMsgIds.has(message.dataset.id));
  });
  const toolbar = document.getElementById('selection-toolbar');
  const count = document.getElementById('selection-count');
  if (toolbar) toolbar.classList.toggle('hidden', !isSelectMode);
  if (count) count.innerText = `${selectedMsgIds.size}件選択中`;
}

function cancelSelectMode() {
  isSelectMode = false;
  selectedMsgIds.clear();
  updateSelectionUI();
}

function deleteSelectedMessages() {
  if (!selectedMsgIds.size) return;
  if (!confirm(`${selectedMsgIds.size}件のメッセージを削除しますか？`)) return;
  const ids = Array.from(selectedMsgIds);
  ids.forEach(deleteLocalMessage);
  if (activeConn && activeConn.open) activeConn.send({ type: 'delete_multiple', ids });
  cancelSelectMode();
}

function deleteMessageWithNotice(msgId) {
  deleteLocalMessage(msgId);
  if (activeConn && activeConn.open) activeConn.send({ type: 'delete', id: msgId });
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
  if (elem) elem.closest('.msg-row')?.remove();
  updateUnreadBadgeCount();
  scrollMessageListToBottom();
}

function updateBadge(count) {
  if (typeof navigator.setAppBadge !== 'function') return;

  const badgeAction = count > 0
    ? navigator.setAppBadge(count)
    : (typeof navigator.clearAppBadge === 'function' ? navigator.clearAppBadge() : null);

  if (badgeAction && typeof badgeAction.catch === 'function') {
    badgeAction.catch((error) => {
      console.warn('アプリアイコンのバッジ更新に失敗しました:', error);
    });
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
  if (activeConn && activeConn.open && partnerIsOnline) {
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
      const sent = await triggerPushNotification(
        'GitHub Action Notification',
        'EditCode: commit and build completed successfully.',
        true
      );
      if (sent) {
        alert('相手がオフラインのため呼び出し通知を送信しました');
      }
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
      audio.playsInline = true;
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
  isSpeakerphoneEnabled = false;
  showCallBar(false);
}

async function toggleSpeakerphone() {
  const audio = document.getElementById('remote-audio');
  if (!audio) return;

  if (typeof audio.setSinkId !== 'function' ||
      typeof navigator.mediaDevices?.selectAudioOutput !== 'function') {
    alert('このブラウザでは通話中のスピーカー切り替えに対応していません');
    return;
  }

  try {
    const outputDevice = await navigator.mediaDevices.selectAudioOutput({ kind: 'audiooutput' });
    await audio.setSinkId(outputDevice.deviceId);
    isSpeakerphoneEnabled = true;
    updateSpeakerphoneButton();
  } catch (error) {
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') {
      console.error('スピーカー出力の切り替えに失敗しました:', error);
      alert('スピーカー出力に切り替えられませんでした');
    }
  }
}

function updateSpeakerphoneButton() {
  const button = document.getElementById('speakerphone-button');
  if (!button) return;
  button.innerText = isSpeakerphoneEnabled ? '📢 スピーカーホン中' : '🔊 スピーカーホン';
  button.setAttribute('aria-pressed', String(isSpeakerphoneEnabled));
}

function showCallBar(show) {
  let callBar = document.getElementById('call-bar');
  if (!callBar) {
    callBar = document.createElement('div');
    callBar.id = 'call-bar';
    callBar.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:40px;background:#28a745;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 16px;z-index:3000;font-size:14px;font-weight:bold;';
    callBar.innerHTML = '<span>📞 通話中...</span><div style="display:flex;gap:6px;align-items:center;"><button id="speakerphone-button" onclick="toggleSpeakerphone()" style="background:#198754;color:#fff;border:none;padding:4px 10px;border-radius:4px;font-weight:bold;cursor:pointer;">🔊 スピーカーホン</button><button onclick="endCall()" style="background:#dc3545;color:#fff;border:none;padding:4px 12px;border-radius:4px;font-weight:bold;cursor:pointer;">📵 終了</button></div>';
    document.body.appendChild(callBar);
  }
  callBar.style.display = show ? 'flex' : 'none';
  if (show) updateSpeakerphoneButton();
}

function appendSystemMsg(text) {
  const list = document.getElementById('message-list');
  if (!list) return;
  const msg = document.createElement('div');
  msg.className = 'system-msg';
  msg.innerText = text;
  list.appendChild(msg);
  scrollMessageListToBottom();
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
