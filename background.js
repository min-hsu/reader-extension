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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;

  chrome.tabs.sendMessage(tab.id, {
    type: "reader-start-from-selection",
  });
});
