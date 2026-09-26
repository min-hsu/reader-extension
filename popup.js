/**
 * 頁面朗讀助手 - popup script
 * 負責 UI 互動並透過 chrome.tabs + runtime.sendMessage 與 content script 通訊
 */

const toggleBtn = document.getElementById("toggleBtn");
const stopBtn = document.getElementById("stopBtn");
const startFromSelectionBtn = document.getElementById("startFromSelectionBtn");
const rateDownBtn = document.getElementById("rateDownBtn");
const rateUpBtn = document.getElementById("rateUpBtn");
const rateValueEl = document.getElementById("rateValue");
const colorPicker = document.getElementById("colorPicker");
const statusMsg = document.getElementById("statusMsg");

const RATE_STEP = 0.25;

let activeTabId = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToContent(message) {
  return new Promise((resolve) => {
    if (!activeTabId) {
      resolve({ ok: false, error: "no-active-tab" });
      return;
    }
    chrome.tabs.sendMessage(activeTabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false });
    });
  });
}

function renderStatus(status) {
  if (!status) return;
  if (typeof status.rate === "number") {
    rateValueEl.textContent = status.rate.toFixed(2);
  }
  if (status.highlightColor) {
    colorPicker.value = status.highlightColor;
  }
  if (status.isPlaying && !status.isPaused) {
    toggleBtn.textContent = "⏸ 暫停";
  } else {
    toggleBtn.textContent = "▶ 播放";
  }
  if (status.message) {
    statusMsg.textContent = status.message;
  }
}

async function init() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    statusMsg.textContent = "無法取得目前分頁";
    return;
  }
  activeTabId = tab.id;

  const isRestrictedUrl = /^(chrome|edge|about|chrome-extension):/.test(tab.url || "");
  if (isRestrictedUrl) {
    statusMsg.textContent = "此頁面不支援朗讀（瀏覽器內建頁面）";
    toggleBtn.disabled = true;
    stopBtn.disabled = true;
    rateDownBtn.disabled = true;
    rateUpBtn.disabled = true;
    colorPicker.disabled = true;
    return;
  }

  const status = await sendToContent({ type: "reader-get-status" });
  if (status.ok) {
    renderStatus(status);
  } else {
    statusMsg.textContent = "請重新整理頁面後再試（擴充功能剛安裝或更新時需重新載入頁面）";
  }
}

toggleBtn.addEventListener("click", async () => {
  await sendToContent({ type: "reader-toggle" });
  const status = await sendToContent({ type: "reader-get-status" });
  renderStatus(status);
});

stopBtn.addEventListener("click", async () => {
  await sendToContent({ type: "reader-stop" });
  const status = await sendToContent({ type: "reader-get-status" });
  renderStatus(status);
  toggleBtn.textContent = "▶ 播放";
});

startFromSelectionBtn.addEventListener("click", async () => {
  const res = await sendToContent({ type: "reader-start-from-selection" });
  if (!res.ok) {
    statusMsg.textContent = "找不到選取內容，請先在頁面上選取一段文字";
    return;
  }
  const status = await sendToContent({ type: "reader-get-status" });
  renderStatus(status);
});

rateDownBtn.addEventListener("click", async () => {
  const res = await sendToContent({ type: "reader-rate-delta", payload: { delta: -RATE_STEP } });
  if (res.ok) rateValueEl.textContent = res.rate.toFixed(2);
});

rateUpBtn.addEventListener("click", async () => {
  const res = await sendToContent({ type: "reader-rate-delta", payload: { delta: RATE_STEP } });
  if (res.ok) rateValueEl.textContent = res.rate.toFixed(2);
});

colorPicker.addEventListener("input", async (event) => {
  await sendToContent({ type: "reader-set-color", payload: { color: event.target.value } });
});

// 監聽 content script 主動推送的狀態（例如朗讀自然結束、空白鍵觸發等）
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "reader-status") {
    renderStatus(message.payload);
  }
});

init();
