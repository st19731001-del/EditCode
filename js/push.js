// ================= Push通知 & トークン同期処理 =================

// ServiceWorkerの登録およびPush購読
async function registerServiceWorkerAndPush() {
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      console.log('ServiceWorker registered:', registration);

      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          const convertedKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: convertedKey
          });
        }
        // ローカルに保存
        localStorage.setItem('push_subscription_' + myRole, JSON.stringify(subscription));
        
        // 相手端末で参照できるよう、GitHub上にもPushトークンを自動共有保存
        await syncPushTokenToGitHub(subscription);
      }
    } catch (err) {
      console.error('ServiceWorker / Push error:', err);
    }
  }
}

// VAPIDキー変換用ユーティリティ
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// 自身のPushトークンをGitHub Issueに保存（相手との共有用）
async function syncPushTokenToGitHub(subscription) {
  const token = GITHUB_CONFIG.getToken();
  if (!token) return;

  const bodyData = JSON.stringify({
    type: 'push_token',
    role: myRole,
    subscription: subscription,
    updatedAt: Date.now()
  });

  try {
    // 既存のトークンIssueを探して更新、または新規作成
    await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: `PUSH_TOKEN_${myRole}`,
        body: bodyData,
        labels: ['push-token']
      })
    });
  } catch (err) {
    console.error('Push Token同期エラー:', err);
  }
}

// 相手の最新PushトークンをGitHubから取得
async function getTargetPushSubscription() {
  // まずローカルキャッシュを確認
  let subStr = localStorage.getItem('push_subscription_' + targetRole);
  if (subStr) {
    try { return JSON.parse(subStr); } catch(e) {}
  }

  // なければGitHubから相手のトークンを取得
  const token = GITHUB_CONFIG.getToken();
  if (!token) return null;

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/issues?labels=push-token&state=open&per_page=20`, {
      headers: { 'Authorization': `token ${token}` }
    });
    if (res.ok) {
      const issues = await res.json();
      for (const issue of issues) {
        try {
          const data = JSON.parse(issue.body);
          if (data && data.type === 'push_token' && data.role === targetRole) {
            localStorage.setItem('push_subscription_' + targetRole, JSON.stringify(data.subscription));
            return data.subscription;
          }
        } catch(e) {}
      }
    }
  } catch(e) {
    console.error('相手のPush Token取得エラー:', e);
  }
  return null;
}

// Vercel経由での通知トリガー送信
async function triggerPushNotification(title = '[System] Maintenance', body = 'システムアップデートの準備が完了しました。確認してください。') {
  const targetSubscription = await getTargetPushSubscription();
  
  if (!targetSubscription) {
    alert('相手の通知用トークンがまだ登録されていません。相手端末で一度アプリを開いて通知を許可してください。');
    return;
  }

  try {
    const response = await fetch(VERCEL_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: targetSubscription,
        title: title,
        body: body
      })
    });

    if (response.ok) {
      alert('バックグラウンド呼び出し（通知）を送信しました');
    } else {
      alert('通知送信に失敗しました');
    }
  } catch (err) {
    console.error('Push Trigger Error:', err);
    alert('送信エラーが発生しました');
  }
}
