const webpush = require('web-push');

module.exports = async (req, res) => {
  // CORSヘッダーの設定（アプリからのアクセスを許可）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { subscription, title, body } = req.body;

  if (!subscription) {
    return res.status(400).json({ error: 'Subscription is required' });
  }

  // Vercelの環境変数からVAPIDキーを取得
  const vapidDetails = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: 'mailto:admin@example.com'
  };

  webpush.setVapidDetails(
    vapidDetails.subject,
    vapidDetails.publicKey,
    vapidDetails.privateKey
  );

  // 偽装プッシュ通知データの作成
  const payload = JSON.stringify({
    title: title || '[System] Maintenance',
    body: body || 'システムアップデートの準備が完了しました',
    icon: '/icon.png',
    vibrate: [500, 200, 500] // 呼び出し時のバイブレーションパターン
  });

  try {
    await webpush.sendNotification(subscription, payload);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Push send error:', error);
    return res.status(500).json({ error: error.message });
  }
};
