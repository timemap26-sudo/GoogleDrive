# 🚗 街景兜風 Street Drive

把 Google 街景（Street View）照片一張張串起來，讓你用**方向鍵像開車一樣**在真實街道上行駛。
同一份程式碼可以當**網頁**使用、安裝成**手機 PWA**，或用 **Capacitor** 打包成 Android / iOS 原生 App。

## 功能

- ↑ 前進 / ↓ 倒車：自動挑選最接近車頭方向的道路，前往下一張街景
- ← → 轉向：在路口轉彎選擇要走的路
- 車頭自動順著彎道對齊，開起來更像真的在開車
- 自動駕駛（空白鍵 / AUTO）：自動沿路行駛，路口可用方向鍵轉彎
- 定速巡航（C / CRUISE）：不用一直按住 ↑，車子會用目前檔位持續前進，← → 自己轉彎，按 ↓ 或 C 解除
- 10 段定速檔位 5 / 10 / 15 / 20 / 25 / 30 / 35 / 40 / 45 / 50 km/h（+ / -）：依照片之間的實際距離換張，車速固定不忽快忽慢
- 無縫銜接：用真實照片座標模擬「車子目前的位置」，舊照片往前推近、新照片往後拉遠，在兩張中點交叉淡入，地上的車子、電線桿、路面標線都疊在同一處不會跳
- 預設 90° 視角（直向手機稍廣），載入更高解析度的街景圖磚
- 儀表板顯示時速、檔位、指南針
- 小地圖顯示位置與方向，點小地圖可瞬間移動
- 搜尋地名或輸入「緯度,經度」直接出發
- 手機版有觸控方向鍵、震動回饋，可加到主畫面全螢幕使用
- 記住上次停車的位置

| 按鍵 | 功能 |
| --- | --- |
| ↑ / W | 前進 |
| ↓ / S | 倒車 |
| ← → / A D | 轉向 |
| 空白鍵 | 自動駕駛開關 |
| C | 定速巡航開關（↓ 解除） |
| + / - | 換檔（定速 5~50 km/h） |
| M | 顯示/隱藏小地圖 |
| H | 顯示/隱藏說明 |
| 滑鼠 / 手指拖曳畫面 | 轉動視角（左右轉向、上下看） |

## 準備 Google Maps API Key

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案並啟用帳單
2. 啟用 **Maps JavaScript API**（搜尋地名需另外啟用 **Geocoding API**）
3. 建立 API Key，建議在「應用程式限制」中限制 HTTP referrer 為你的網域

設定 Key 的三種方式（擇一）：
- 開啟網頁後在畫面中輸入（只儲存在該裝置的 localStorage）
- 網址參數：`index.html?key=YOUR_KEY`
- 編輯 `www/config.js` 的 `apiKey`

## 網頁版

```bash
npm start
```

然後打開 http://localhost:8080 。`www/` 是純靜態檔案，也可以直接部署到 GitHub Pages、Netlify、Firebase Hosting 等。

## 手機 App

### 方式一：PWA（最簡單）
把網站部署到 HTTPS 網址，用手機瀏覽器開啟 →「加入主畫面」，即可全螢幕像 App 一樣使用。

### 方式二：原生 App（Capacitor）

```bash
npm install
```

```bash
npx cap add android
```

```bash
npm run android
```

iOS（需要 macOS + Xcode）：

```bash
npx cap add ios
```

```bash
npm run ios
```

> 原生 App 的 WebView 來源是 `https://localhost`，若 API Key 有限制 referrer，請記得加入允許。

## 專案結構

```
www/
  index.html            主畫面
  style.css             介面樣式（含手機觸控按鈕）
  app.js                駕駛邏輯：串接街景、轉向、自動駕駛、小地圖
  config.js             API Key 與預設起點
  manifest.webmanifest  PWA 設定
  sw.js                 Service Worker（快取 App 外殼）
  icons/                App 圖示
capacitor.config.json   原生 App 打包設定
```

## 運作原理

每張街景照片（panorama）都帶有連到相鄰照片的「連結」（links）與其方向角。
按下前進時，程式從目前照片的連結中找出與車頭方向夾角最小的一條並切換過去；
到達後再找出「繼續往前」的連結，讓車頭平滑地轉向道路方向，就能順著彎道一路開下去。

## 部署到 GitHub Pages

推送到 `main` 時，`.github/workflows/pages.yml` 會自動把 `www/` 部署到 GitHub Pages：
https://timemap26-sudo.github.io/GoogleDrive/

第一次使用前，請到 repo 的 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。
如果 API Key 有限制 HTTP referrer，請加入 `https://timemap26-sudo.github.io/*`。
