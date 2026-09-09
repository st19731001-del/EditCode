// ================= 設定・定数管理 =================
const VERCEL_API_URL = 'https://editcode-push.vercel.app/api/push';
const VAPID_PUBLIC_KEY = 'BK4M5xmRO3I6Kuhv2sGBfRX4A4cXpAHCdmj74cxLFD3ytLqmyCzooRC_LUny8cXzwNs_npD3cMfuYRqsYMbADK0';

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

const SECRET_PIN = '904900'; // 開発者用PINコード

// ユーザーロール判定 (user_a / user_b)
const savedRole = localStorage.getItem('user_role');
const urlParams = new URLSearchParams(window.location.search);
const urlRole = urlParams.get('user') === 'b' ? 'user_b' : (urlParams.get('user') === 'a' ? 'user_a' : null);

const myRole = savedRole || urlRole || 'user_a';
const targetRole = myRole === 'user_a' ? 'user_b' : 'user_a';
