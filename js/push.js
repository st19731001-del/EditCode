// ================= Push通知 & トークン同期処理 =================

// ServiceWorkerの登録およびPush購読
async function registerServiceWorkerAndPush() {
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    try {
      // ユーザー操作から呼ばれた場合に通知許可を取得できるよう、最初のawaitより前に開始する
      const permissionPromise = Notification.permission === 'default'
        ? Notification.requestPermission()
        : Promise.resolve(Notification.permission);
      const registration = await navigator.serviceWorker.register('./sw.js');
      await registration.update();
      console.log('ServiceWorker registered:', registration);

      const permission = await permissionPromise;
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
    const apiUrl = `https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}`;
    const headers = {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json'
    };
    const issuesResponse = await fetch(`${apiUrl}/issues?labels=push-token&state=open&per_page=100`, { headers });
    const issues = issuesResponse.ok ? await issuesResponse.json() : [];
    const existingIssue = issues.find(issue => issue.title === `PUSH_TOKEN_${myRole}`);
    const issueData = {
      title: `PUSH_TOKEN_${myRole}`,
      body: bodyData,
      labels: ['push-token']
    };

    // 同じロールの購読Issueを更新し、通知先の重複・古い購読情報を防ぐ
    await fetch(existingIssue ? `${apiUrl}/issues/${existingIssue.number}` : `${apiUrl}/issues`, {
      method: existingIssue ? 'PATCH' : 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(issueData)
    });
  } catch (err) {
    console.error('Push Token同期エラー:', err);
  }
}

// 相手の最新PushトークンをGitHubから取得
async function getTargetPushSubscription() {
  // 通知先は更新されるため、毎回GitHubから最新の購読情報を取得する
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

  const cachedSubscription = localStorage.getItem('push_subscription_' + targetRole);
  if (cachedSubscription) {
    try { return JSON.parse(cachedSubscription); } catch(e) {}
  }
  return null;
}

// Vercel経由での通知トリガー送信
// 修正: silent=true の場合、成功/失敗のalert()を出さない
// (メッセージ送信のたびに自動でPush通知をトリガーするようになったため、
//  ユーザー操作を伴わない自動実行時にまでアラートが出るのを防ぐ)
async function triggerPushNotification(title = '[System] Maintenance', body = 'システムアップデートの準備が完了しました。確認してください。', silent = false) {
  const targetSubscription = await getTargetPushSubscription();
  
  if (!targetSubscription) {
    if (!silent) {
      alert('相手の通知用トークンがまだ登録されていません。相手端末で一度アプリを開いて通知を許可してください。');
    }
    return false;
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
      if (!silent) alert('バックグラウンド呼び出し（通知）を送信しました');
      return true;
    } else {
      let result = null;
      try { result = await response.json(); } catch (e) {}

      if (response.status === 410 || (result && result.expired)) {
        localStorage.removeItem('push_subscription_' + targetRole);
        if (!silent) alert('相手の通知トークンが失効しています。相手端末でアプリを開き直してもらってください。');
      } else {
        if (!silent) alert('通知送信に失敗しました');
      }
      return false;
    }
  } catch (err) {
    console.error('Push Trigger Error:', err);
    if (!silent) alert('送信エラーが発生しました');
    return false;
  }
}
