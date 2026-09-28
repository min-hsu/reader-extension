/**
 * 頁面朗讀助手 - background service worker
 * 負責建立右鍵選單「從此處開始朗讀」，並將觸發轉發給 content script
 */

const MENU_ID = "reader-extension-start-from-selection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "從選取處開始朗讀",
    contexts: ["selection"],
  });
});

// ---------- 跨分頁朗讀擁有權 ----------
// speechSynthesis 在瀏覽器內是全域共用的，同一時間只讓一個分頁朗讀。
// 擁有者 tabId 存在 storage.session，避免 service worker 休眠後遺失。
const OWNER_KEY = "reader-owner-tab-id";

async function getOwnerTabId() {
  const result = await chrome.storage.session.get(OWNER_KEY);
  return result[OWNER_KEY] ?? null;
}

async function setOwnerTabId(tabId) {
  if (tabId == null) {
    await chrome.storage.session.remove(OWNER_KEY);
  } else {
    await chrome.storage.session.set({ [OWNER_KEY]: tabId });
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  if (message?.type === "reader-claim") {
    (async () => {
      const previous = await getOwnerTabId();
      await setOwnerTabId(tabId);
      if (previous != null && previous !== tabId) {
        chrome.tabs.sendMessage(previous, { type: "reader-force-stop" }).catch(() => {
          // 舊分頁可能已關閉或無 content script，忽略
        });
      }
    })();
  } else if (message?.type === "reader-release") {
    (async () => {
      if ((await getOwnerTabId()) === tabId) await setOwnerTabId(null);
    })();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getOwnerTabId()) === tabId) await setOwnerTabId(null);
});

// ---------- 全域快捷鍵（chrome.commands，可於 chrome://extensions/shortcuts 修改） ----------
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-reading") return;
  const target = tab?.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target?.id) return;
  chrome.tabs.sendMessage(target.id, { type: "reader-toggle" }).catch(() => {
    // 瀏覽器內建頁面或尚未注入 content script 的分頁，忽略
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;

  chrome.tabs.sendMessage(tab.id, {
    type: "reader-start-from-selection",
  });
});
