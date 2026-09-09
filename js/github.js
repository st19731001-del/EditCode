// ================= GitHub Issues 連携 (オフライン通信 & 画像圧縮) =================

// 画像の自動圧縮処理 (iPhone等の受信エラー・未読残りを防ぐため100KB〜200KB前後に極小化)
function compressImage(file, maxWidth = 800, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // JPEG形式で圧縮してBase64文字列を取得
        const compressedBase64 = canvas.toDataURL('image/jpeg', quality);
        resolve(compressedBase64);
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
}

// 画像・ファイル選択時のハンドラ
async function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    let fileData = '';
    let fileType = file.type;

    // 画像ファイルの場合は自動圧縮を適用
    if (file.type.startsWith('image/')) {
      fileData = await compressImage(file, 800, 0.6);
      fileType = 'image/jpeg';
    } else {
      if (file.size > 2 * 1024 * 1024) {
        alert('画像以外のファイルは2MB以下にしてください');
        event.target.value = '';
        return;
      }
      fileData = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
      });
    }

    await dispatchMessage(file.name, false, {
      data: fileData,
      name: file.name,
      type: fileType
    });
  } catch (err) {
    console.error('ファイル処理エラー:', err);
    alert('ファイルの処理に失敗しました');
  } finally {
    event.target.value = '';
  }
}

// メッセージ送信の振分け (オンライン: PeerJS / オフライン: GitHub Issue)
async function dispatchMessage(text, isStamp = false, fileObj = null) {
  const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const isOnline = activeConn && activeConn.open;
  const now = Date.now();
  
  const msgObj = {
    id: msgId,
    text: text,
    replyText: currentReplyTo ? currentReplyTo.text : null,
    fileData: fileObj ? fileObj.data : null,
    fileName: fileObj ? fileObj.name : null,
    fileType: fileObj ? fileObj.type : null,
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
      fileData: msgObj.fileData,
      fileName: msgObj.fileName,
      fileType: msgObj.fileType,
      isStamp: isStamp, 
      id: msgId,
      timestamp: now
    });
  } else {
    await saveMessageToGitHub(text, isStamp, msgId, msgObj.replyText, now, fileObj);
  }
}

// オフラインメッセージをGitHub Issueとして保存
async function saveMessageToGitHub(text, isStamp, msgId, replyText = null, timestamp = Date.now(), fileObj = null) {
  const token = GITHUB_CONFIG.getToken();
  if (!token) return;

  const bodyData = JSON.stringify({
    id: msgId,
    sender: myRole,
    target: targetRole,
    text: text,
    replyText: replyText,
    fileData: fileObj ? fileObj.data : null,
    fileName: fileObj ? fileObj.name : null,
    fileType: fileObj ? fileObj.type : null,
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
// GitHubから未読のオフラインメッセージを取得・同期
async function fetchOfflineMessages() {
  const token = GITHUB_CONFIG.getToken();
  if (!token) return;

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues?labels=offline-msg&state=open&per_page=100`, {
      headers: { 'Authorization': `token ${token}` }
    });
    
    if (res.ok) {
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
    }

    syncClosedMyMessages(token);
    updateUnreadBadgeCount();
  } catch (err) {
    console.error('未読取得エラー:', err);
  }
}

// 自分が送信したメッセージの既読同期（相手がクローズしたか確認）
async function syncClosedMyMessages(token) {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues?labels=offline-msg&state=closed&per_page=50`, {
      headers: { 'Authorization': `token ${token}` }
    });
    if (!res.ok) return;
    const closedIssues = await res.json();

    if (Array.isArray(closedIssues)) {
      closedIssues.forEach(issue => {
        try {
          const data = JSON.parse(issue.body);
          if (data && data.sender === myRole && data.id) {
            markMyMessagesAsRead(data.id);
          }
        } catch(e) {}
      });
    }
  } catch(e) {
    console.error('既読同期エラー:', e);
  }
}

// GitHub Issueをクローズ（既読化処理）
async function closeGitHubIssue(issueNumber, token) {
  try {
    await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'EditCode-App'
      },
      body: JSON.stringify({ state: 'closed' })
    });
  } catch(e) {
    console.error('Issueクローズエラー:', e);
  }
}
