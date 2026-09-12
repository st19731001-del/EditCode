// ================= GitHub Issues 連携 (オフライン通信 & 画像圧縮) =================

// 修正: GitHub Issueの本文は最大 65536文字。JSONの他フィールド分の余白を見て
// Base64画像は安全のため 50,000文字以下に収める。収まるまで段階的に再圧縮する。
const GITHUB_BODY_SAFE_LIMIT = 50000;

// 画像の自動圧縮処理 (iPhone等の受信エラー・未読残りを防ぐため100KB〜200KB前後に極小化)
// 修正: 圧縮後のサイズがGitHub Issueの本文上限を超える場合、
// 従来は無条件でそのまま送信し、GitHub側で422エラーとなって「送信されたように見えるが
// 実際にはIssueが作成されておらず、相手には永久に届かない」バグの温床になっていた。
// これを防ぐため、上限を下回るまで width / quality を段階的に下げて再試行する。
function compressImage(file, maxWidth = 800, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        try {
          let currentWidth = maxWidth;
          let currentQuality = quality;
          let result = null;

          for (let attempt = 0; attempt < 6; attempt++) {
            let width = img.width;
            let height = img.height;

            if (width > currentWidth) {
              height = Math.round((height * currentWidth) / width);
              width = currentWidth;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            result = canvas.toDataURL('image/jpeg', currentQuality);

            if (result.length <= GITHUB_BODY_SAFE_LIMIT) {
              resolve(result);
              return;
            }

            // まだ大きい場合は解像度と画質をさらに下げて再試行
            currentWidth = Math.round(currentWidth * 0.75);
            currentQuality = Math.max(0.3, currentQuality - 0.1);
          }

          // 6回試しても収まらない場合でも、最後の結果を返す
          // (呼び出し側で最終サイズチェックを行う)
          resolve(result);
        } catch (err) {
          reject(err);
        }
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

      // 修正: それでもGitHub Issue本文の上限を超える場合は送信前に止める
      // (オンラインP2P経由なら上限は無いので、その場合のみ許可する)
      const isOnlineNow = activeConn && activeConn.open;
      if (!isOnlineNow && fileData.length > GITHUB_BODY_SAFE_LIMIT) {
        alert('画像サイズが大きすぎるため、オフライン送信できませんでした。P2P接続時に再度お試しください。');
        event.target.value = '';
        return;
      }
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

      // 修正: 非画像ファイルもBase64化するとGitHub Issue上限を超えうるためチェック
      const isOnlineNow2 = activeConn && activeConn.open;
      if (!isOnlineNow2 && fileData.length > GITHUB_BODY_SAFE_LIMIT) {
        alert('このファイルはオフライン送信には大きすぎます。P2P接続時に再度お試しください。');
        event.target.value = '';
        return;
      }
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

    // 修正(原因3): 送信時点で activeConn.open が true でも、送信直後に切断される
    // レースコンディションで相手に届かず、かつどこにも残らずロストするケースがあった。
    // P2Pで送った場合も「保険」としてGitHub Issueに非同期でバックアップ保存しておく。
    // (画像が大きすぎてオフライン保存できない場合はスキップされるだけで、P2P送信自体は成立している)
    if (!fileObj || fileData_isSafeForGithub(fileObj)) {
      saveMessageToGitHub(text, isStamp, msgId, msgObj.replyText, now, fileObj).catch(() => {});
    }
  } else {
    const ok = await saveMessageToGitHub(text, isStamp, msgId, msgObj.replyText, now, fileObj);
    if (!ok) {
      markMessageAsFailed(msgId);
    } else {
      // 修正(原因1): オフライン保存が成功したら、相手のバックグラウンド端末に
      // 到着を知らせるPush通知を送る（従来はここが完全に欠落していた）
      if (typeof triggerPushNotification === 'function') {
        triggerPushNotification(
          '新着メッセージ',
          isStamp ? 'スタンプが届きました' : (fileObj ? 'ファイルが届きました' : 'メッセージが届きました')
        ).catch(() => {});
      }
    }
  }
}

// P2Pバックアップ保存の際、画像が大きすぎてGitHub上限を超える場合はバックアップをスキップする
function fileData_isSafeForGithub(fileObj) {
  if (!fileObj || !fileObj.data) return true;
  return fileObj.data.length <= GITHUB_BODY_SAFE_LIMIT;
}

// オフラインメッセージをGitHub Issueとして保存
async function saveMessageToGitHub(text, isStamp, msgId, replyText = null, timestamp = Date.now(), fileObj = null) {
  const token = GITHUB_CONFIG.getToken();
  if (!token) return false;

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

  // 修正(原因2): fetch()はHTTPエラー(422等)でも例外を投げないため、
  // 従来は res.ok を確認しておらず、本文サイズ超過などで保存が失敗していても
  // 気づかずに「送信済み」の表示のまま相手には永久に届かない状態になっていた。
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues`, {
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

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('GitHub保存失敗:', res.status, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error('GitHub保存エラー:', err);
    return false;
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

// 修正(原因3): P2P経由でメッセージを受信した際、read_ackがP2P上でしか送られず、
// 相手が切断中などでackを受け取れないと既読が永久に反映されないバグがあった。
// dispatchMessage側でオンライン送信時もGitHub Issueをバックアップ作成するようにしたため、
// P2Pで受信・既読化した際にも「対応するGitHub Issueがあれば」念のため閉じておくことで、
// 相手が後からオフライン同期(syncClosedMyMessages)した際にも既読が正しく反映されるようにする。
async function closeGitHubIssueByMsgId(msgId, token) {
  if (!token || !msgId) return;
  try {
    const q = encodeURIComponent(`repo:${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo} type:issue state:open MSG_${msgId} in:title`);
    const res = await fetch(`https://api.github.com/search/issues?q=${q}`, {
      headers: { 'Authorization': `token ${token}` }
    });
    if (!res.ok) return;
    const result = await res.json();
    if (result && Array.isArray(result.items)) {
      for (const item of result.items) {
        if (item.title === `MSG_${msgId}`) {
          await closeGitHubIssue(item.number, token);
        }
      }
    }
  } catch (e) {
    // ベストエフォートのため失敗しても無視する
  }
}
