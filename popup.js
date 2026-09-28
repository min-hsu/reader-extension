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

// 監聽 content script 主動推送的狀態（例如朗讀自然結束、快捷鍵觸發等）
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "reader-status") {
    renderStatus(message.payload);
  }
});

// ---------- 快捷鍵設定 ----------

const STORAGE_KEY = "reader-extension-settings"; // 與 content.js 共用
const DEFAULT_PAGE_SHORTCUT = { code: "Space", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock", "Fn",
]);
const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

const globalShortcutValueEl = document.getElementById("globalShortcutValue");
const editGlobalShortcutBtn = document.getElementById("editGlobalShortcutBtn");
const pageShortcutValueEl = document.getElementById("pageShortcutValue");
const pageShortcutEnabledEl = document.getElementById("pageShortcutEnabled");
const recordPageShortcutBtn = document.getElementById("recordPageShortcutBtn");
const resetPageShortcutBtn = document.getElementById("resetPageShortcutBtn");

let isRecording = false;

function formatKeyCode(code) {
  if (code === "Space") return "空白鍵";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`;
  const arrows = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  return arrows[code] || code;
}

function formatShortcut(shortcut) {
  const parts = [];
  if (shortcut.ctrlKey) parts.push(IS_MAC ? "⌃" : "Ctrl");
  if (shortcut.altKey) parts.push(IS_MAC ? "⌥" : "Alt");
  if (shortcut.shiftKey) parts.push(IS_MAC ? "⇧" : "Shift");
  if (shortcut.metaKey) parts.push(IS_MAC ? "⌘" : "Win");
  parts.push(formatKeyCode(shortcut.code));
  return parts.join(IS_MAC ? "" : "+");
}

async function readSettings() {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

// 先讀出完整設定再合併寫回，避免覆蓋 content script 保存的語速、顏色
async function updateSettings(patch) {
  const current = await readSettings();
  await chrome.storage.sync.set({ [STORAGE_KEY]: { ...current, ...patch } });
}

function renderPageShortcut(settings) {
  const shortcut = settings.pageShortcut || DEFAULT_PAGE_SHORTCUT;
  const enabled = settings.pageShortcutEnabled !== false;
  pageShortcutValueEl.textContent = formatShortcut(shortcut);
  pageShortcutEnabledEl.checked = enabled;
  recordPageShortcutBtn.disabled = !enabled;
  resetPageShortcutBtn.disabled = !enabled;
}

async function renderGlobalShortcut() {
  const commands = await chrome.commands.getAll();
  const command = commands.find((c) => c.name === "toggle-reading");
  // 建議快捷鍵與其他擴充功能衝突時，Chrome 不會註冊，shortcut 會是空字串
  globalShortcutValueEl.textContent = command?.shortcut || "未設定";
}

function stopRecording() {
  isRecording = false;
  recordPageShortcutBtn.classList.remove("recording");
  recordPageShortcutBtn.textContent = "錄製新按鍵";
}

async function initShortcutSettings() {
  renderPageShortcut(await readSettings());
  await renderGlobalShortcut();
}

// Chrome 不開放擴充功能以程式修改 chrome.commands，只能引導到瀏覽器內建設定頁
editGlobalShortcutBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

pageShortcutEnabledEl.addEventListener("change", async () => {
  await updateSettings({ pageShortcutEnabled: pageShortcutEnabledEl.checked });
  renderPageShortcut(await readSettings());
});

recordPageShortcutBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
    return;
  }
  isRecording = true;
  recordPageShortcutBtn.classList.add("recording");
  recordPageShortcutBtn.textContent = "請按下按鍵（Esc 取消）";
  statusMsg.textContent = "";
});

resetPageShortcutBtn.addEventListener("click", async () => {
  stopRecording();
  await updateSettings({ pageShortcut: DEFAULT_PAGE_SHORTCUT });
  renderPageShortcut(await readSettings());
  statusMsg.textContent = "已重設為空白鍵";
});

document.addEventListener("keydown", async (event) => {
  if (!isRecording) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.code === "Escape") {
    stopRecording();
    return;
  }
  if (MODIFIER_CODES.has(event.code)) return; // 只按修飾鍵時繼續等待主鍵

  const shortcut = {
    code: event.code,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  };
  stopRecording();
  await updateSettings({ pageShortcut: shortcut });
  renderPageShortcut(await readSettings());

  const hasStrongModifier = shortcut.ctrlKey || shortcut.altKey || shortcut.metaKey;
  statusMsg.textContent = hasStrongModifier
    ? `頁內快捷鍵已設為 ${formatShortcut(shortcut)}，未朗讀時也可用來開始朗讀`
    : `頁內快捷鍵已設為 ${formatShortcut(shortcut)}，僅在朗讀進行中生效`;
});

initShortcutSettings();
init();
