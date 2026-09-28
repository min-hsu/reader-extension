/**
 * 頁面朗讀助手 - content script
 *
 * 功能：
 * - 掃描頁面可讀文字，切分成句子片段
 * - 使用 Web Speech API 逐句朗讀
 * - 頁內快捷鍵（預設空白鍵，僅朗讀中生效）暫停 / 播放，可在 popup 修改
 * - 語速以 0.25 為單位調整（0.5 ~ 3.0）
 * - 朗讀中的片段以可自訂顏色的 background 高亮
 */

(() => {
  const STORAGE_KEY = "reader-extension-settings";
  const DEFAULT_SETTINGS = {
    rate: 1.0,
    highlightColor: "#ffe066", // 預設高亮背景色（柔和黃）
    pageShortcutEnabled: true,
    // 頁內暫停/播放快捷鍵，以 KeyboardEvent.code 比對（不受鍵盤配置影響）
    pageShortcut: { code: "Space", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
  };

  const MIN_RATE = 0.5;
  const MAX_RATE = 3.0;
  const RATE_STEP = 0.25;

  /** @type {{settings: typeof DEFAULT_SETTINGS, segments: Array<{node: Text, text: string}>, currentIndex: number, isPlaying: boolean, isPaused: boolean, highlightEl: HTMLElement|null}} */
  const state = {
    settings: { ...DEFAULT_SETTINGS },
    segments: [],
    currentIndex: -1,
    isPlaying: false,
    isPaused: false,
    highlightEl: null,
  };

  const synth = window.speechSynthesis;

  // ---------- 設定持久化 ----------

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get([STORAGE_KEY], (result) => {
          const saved = result && result[STORAGE_KEY];
          state.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
          resolve(state.settings);
        });
      } catch (e) {
        resolve(state.settings);
      }
    });
  }

  function saveSettings() {
    try {
      chrome.storage.sync.set({ [STORAGE_KEY]: state.settings });
    } catch (e) {
      // storage 不可用時忽略（例如在受限頁面）
    }
  }

  // ---------- 文字節點收集與分句 ----------

  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
    "IFRAME",
    "SVG",
    "CANVAS",
    "CODE",
    "PRE",
  ]);

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue;
        if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[data-reader-ignore]")) return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    let current;
    while ((current = walker.nextNode())) {
      nodes.push(current);
    }
    return nodes;
  }

  // 依中英文常見句尾符號切句，保留分隔符
  const SENTENCE_SPLIT_REGEX = /(?<=[。！？!?.；;\n])\s*/;

  /**
   * 建立 segments 時，直接用 Text.splitText() 把每個原始文字節點依句子邊界
   * 物理拆分成多個獨立的 Text 節點，讓每個 segment 對應「一整個」Text 節點
   * （而不是同一個節點裡的 start/end 字元範圍）。
   *
   * 這樣做的原因：applyHighlight() 用 range.surroundContents() 高亮時，
   * 瀏覽器會把目標範圍從原始節點中「切出來」包成 <span>，導致原始節點被
   * 拆成前後多段全新的 Text 節點物件。如果多個 segment 共用同一個原始節點、
   * 且靠 start/end 字元 offset 定位，第一次高亮就會打亂節點結構與內容，
   * 使其他 segment 記錄的 offset 全部錯位（表現為「段落間偶爾沒上到背景色」），
   * 而 changeRate() 重新高亮同一個 segment 時也會因為節點內容已被切走
   * 一部分、offset 對不上而包出空範圍（表現為「調整語速時背景色消失」）。
   *
   * 在建立階段就把節點依句子物理拆開後，每個 segment 各自對應一個獨立、
   * 完整、不會被其他 segment 影響的 Text 節點，surroundContents 整個節點
   * 即可，不再需要 offset，也不會有節點互相干擾的問題。
   */
  function splitTextNodeIntoSentences(node) {
    const fullText = node.nodeValue;
    const parts = fullText.split(SENTENCE_SPLIT_REGEX).filter((s) => s.length > 0);

    const resultNodes = [];
    let remaining = node;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        // 最後一段就是 remaining 剩下的全部內容
        resultNodes.push(remaining);
        break;
      }
      // splitText 會把 remaining 從 part.length 處切開，
      // 回傳「後半段」的新 Text 節點，remaining（前半段）保留 part 的內容
      const rest = remaining.splitText(part.length);
      resultNodes.push(remaining);
      remaining = rest;
    }
    return resultNodes;
  }

  function buildSegments() {
    const textNodes = collectTextNodes(document.body);
    /** @type {typeof state.segments} */
    const segments = [];

    for (const node of textNodes) {
      const splitNodes = splitTextNodeIntoSentences(node);
      for (const sentenceNode of splitNodes) {
        const text = sentenceNode.nodeValue.trim();
        if (!text) continue;
        segments.push({ node: sentenceNode, text });
      }
    }

    return segments;
  }

  // ---------- 高亮 ----------

  function clearHighlight() {
    if (state.highlightEl && state.highlightEl.parentNode) {
      const parent = state.highlightEl.parentNode;
      // 將高亮 span 內的節點還原到原位置。
      // 注意：這裡故意不呼叫 parent.normalize()。
      // 雖然 applyHighlight() 現在改用 selectNodeContents() 整段包住 segment.node
      // （不再對節點做局部字元切割），還原後理論上內容完整不會位移；
      // 但若鄰近仍有其他 segment 節點，呼叫 normalize() 仍可能把還原出來的
      // 節點與相鄰文字節點合併成新的節點物件，使該 segment 之後失去對應的
      // node 參照。保持不合併，才能讓每個 segment 的 node 參照長期有效。
      while (state.highlightEl.firstChild) {
        parent.insertBefore(state.highlightEl.firstChild, state.highlightEl);
      }
      parent.removeChild(state.highlightEl);
    }
    state.highlightEl = null;
  }

  function applyHighlight(segment) {
    clearHighlight();

    const { node } = segment;
    // node 可能因先前 DOM 操作（例如其他插件、頁面自身的重新渲染）而失效，
    // 這種情況下直接重建全頁片段索引，而不是靜默放棄高亮。
    if (!node.isConnected) {
      rebuildSegmentsKeepingPosition();
      return;
    }

    try {
      const range = document.createRange();
      // segment.node 在 buildSegments() 階段已經是「一整句」獨立的 Text 節點
      // （由 splitTextNodeIntoSentences 物理拆分而來），直接整段包住即可，
      // 不需要也不應該再用字元 offset 定位，避免與其他 segment 互相干擾。
      range.selectNodeContents(node);

      const mark = document.createElement("span");
      mark.className = "reader-extension-highlight";
      mark.style.backgroundColor = state.settings.highlightColor;
      range.surroundContents(mark);

      state.highlightEl = mark;

      mark.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) {
      // range 操作失敗（例如節點跨越多個父節點），重建片段索引後重試一次，
      // 而不是靜默放棄高亮。
      console.warn("[頁面朗讀助手] 高亮失敗，嘗試重建片段索引：", e);
      rebuildSegmentsKeepingPosition();
    }
  }

  /**
   * 當偵測到目前 segment 的 node 已失效（不在 DOM 樹上）時，
   * 重新掃描全頁文字建立新的 segments，並嘗試以文字內容比對找回
   * 目前朗讀到的位置，避免朗讀繼續但高亮永久消失。
   */
  function rebuildSegmentsKeepingPosition() {
    const previousText = state.segments[state.currentIndex]?.text ?? null;
    const rebuilt = buildSegments();
    state.segments = rebuilt;

    if (previousText) {
      const matchIndex = rebuilt.findIndex((seg) => seg.text === previousText);
      if (matchIndex !== -1) {
        state.currentIndex = matchIndex;
        applyHighlight(rebuilt[matchIndex]);
        return;
      }
    }
    // 找不到對應文字時放棄本次高亮，但不影響朗讀繼續進行。
  }

  // ---------- 從選取位置定位片段 ----------

  /**
   * 依目前使用者的文字選取（window.getSelection）找出對應的 segment index。
   * 邏輯：找到選取範圍的起點所在文字節點與 offset，比對 segments 中
   * 「同一節點且 offset 落在 [start, end) 內」的片段；找不到精確命中時，
   * 退回選用該節點的第一個片段；仍找不到則回傳 -1。
   */
  /**
   * 依目前使用者的文字選取（window.getSelection）找出對應的 segment index。
   * 邏輯：找到選取範圍的起點所在文字節點，比對 segments 中
   * 「node 相同」或「node 是同一個原始節點被物理拆分出來的其中一段」的片段。
   * 由於 buildSegments() 已將每個句子拆成獨立 Text 節點，這裡改用
   * 「選取節點的內容是否被某個 segment 節點包含」來比對，取代原先的 offset 比對。
   */
  function findSegmentIndexFromSelection(segments) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return -1;

    const range = selection.getRangeAt(0);
    let anchorNode = range.startContainer;

    // 若選取的是元素節點（而非文字節點），嘗試往下找第一個文字子節點
    if (anchorNode.nodeType !== Node.TEXT_NODE) {
      const walker = document.createTreeWalker(anchorNode, NodeFilter.SHOW_TEXT);
      const firstText = walker.nextNode();
      if (!firstText) return -1;
      anchorNode = firstText;
    }

    // 精確比對：選取節點正好就是某個 segment 的節點
    const exactIndex = segments.findIndex((seg) => seg.node === anchorNode);
    if (exactIndex !== -1) return exactIndex;

    // 退回比對：選取節點的文字內容有包含在某個 segment 的文字中
    // （例如選取發生在尚未依最新 DOM 重新建立 segment 之前）
    const anchorText = anchorNode.nodeValue?.trim();
    if (anchorText) {
      const looseIndex = segments.findIndex((seg) => seg.text.includes(anchorText) || anchorText.includes(seg.text));
      if (looseIndex !== -1) return looseIndex;
    }

    return -1;
  }

  /**
   * 從使用者當前選取的文字位置開始朗讀，並自動往後接續朗讀後續片段。
   * 會先重新掃描全頁片段以確保索引與最新 DOM 一致。
   */
  function startReadingFromSelection() {
    const freshSegments = buildSegments();
    if (freshSegments.length === 0) {
      notifyStatus("此頁面沒有可朗讀的文字內容");
      return;
    }

    const startIndex = findSegmentIndexFromSelection(freshSegments);
    if (startIndex === -1) {
      notifyStatus("找不到選取位置對應的文字，請重新選取後再試");
      return;
    }

    // 先停止目前的朗讀狀態，避免多個 utterance 疊加
    resetSynth();
    clearHighlight();

    state.segments = freshSegments;
    state.isPlaying = true;
    state.isPaused = false;
    claimReaderOwnership();
    speakSegment(startIndex);
  }

  // ---------- 朗讀控制 ----------

  function clampRate(rate) {
    return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  }

  function speakSegment(index) {
    if (index < 0 || index >= state.segments.length) {
      stopReading();
      return;
    }

    state.currentIndex = index;
    const segment = state.segments[index];
    applyHighlight(segment);

    const utterance = new SpeechSynthesisUtterance(segment.text);
    utterance.rate = state.settings.rate;
    utterance.lang = document.documentElement.lang || "zh-TW";

    utterance.onend = () => {
      if (!state.isPlaying) return;
      speakSegment(index + 1);
    };

    utterance.onerror = (e) => {
      if (e.error === "interrupted" || e.error === "canceled") return;
      console.warn("[頁面朗讀助手] 朗讀錯誤：", e.error);
      speakSegment(index + 1);
    };

    synth.speak(utterance);
    notifyStatus();
  }

  function startReading() {
    if (state.segments.length === 0) {
      state.segments = buildSegments();
    }
    if (state.segments.length === 0) {
      notifyStatus("此頁面沒有可朗讀的文字內容");
      return;
    }

    // speechSynthesis 是整個瀏覽器共用的佇列：其他分頁殘留的 utterance
    // 或全域 paused 狀態會讓本分頁的朗讀排隊卡住，開始前先清乾淨。
    resetSynth();
    state.isPlaying = true;
    state.isPaused = false;
    claimReaderOwnership();
    const startIndex = state.currentIndex >= 0 ? state.currentIndex : 0;
    speakSegment(startIndex);
  }

  function resetSynth() {
    synth.cancel();
    synth.resume();
  }

  function pauseReading() {
    if (!state.isPlaying || state.isPaused) return;
    state.isPaused = true;
    synth.pause();
    notifyStatus();
  }

  function resumeReading() {
    if (!state.isPaused) return;
    state.isPaused = false;
    if (synth.speaking || synth.pending) {
      synth.resume();
    } else {
      // 暫停期間 utterance 可能已被其他分頁或瀏覽器丟棄，直接從目前片段重唸
      resetSynth();
      claimReaderOwnership();
      speakSegment(state.currentIndex);
      return;
    }
    notifyStatus();
  }

  function stopReading() {
    const wasActive = state.isPlaying;
    state.isPlaying = false;
    state.isPaused = false;
    state.currentIndex = -1;
    synth.cancel();
    clearHighlight();
    if (wasActive) releaseReaderOwnership();
    notifyStatus();
  }

  // ---------- 跨分頁協調 ----------
  // 同一時間只允許一個分頁擁有朗讀；由 background 記錄目前擁有者，
  // 新分頁開始朗讀時會通知舊分頁停止。

  function claimReaderOwnership() {
    try {
      chrome.runtime.sendMessage({ type: "reader-claim" });
    } catch (e) {
      // 擴充功能被重新載入後 runtime 失效，忽略
    }
  }

  function releaseReaderOwnership() {
    try {
      chrome.runtime.sendMessage({ type: "reader-release" });
    } catch (e) {
      // 同上
    }
  }

  // 切換到其他分頁 / 最小化視窗：暫停朗讀，回到分頁後按快捷鍵續讀
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      pauseReading();
    }
  });

  // 關閉分頁、重新整理或導向其他頁面：徹底停止，避免語音殘留在共用佇列中繼續播放
  window.addEventListener("pagehide", () => {
    if (state.isPlaying) stopReading();
  });

  function togglePlayPause() {
    if (!state.isPlaying) {
      startReading();
      return;
    }
    if (state.isPaused) {
      resumeReading();
    } else {
      pauseReading();
    }
  }

  function changeRate(delta) {
    const nextRate = Math.round(clampRate(state.settings.rate + delta) * 100) / 100;
    state.settings.rate = nextRate;
    saveSettings();

    // 若正在朗讀，重新以新語速朗讀當前片段以立即生效
    if (state.isPlaying && !state.isPaused) {
      synth.cancel();
      speakSegment(state.currentIndex);
    }
    notifyStatus();
  }

  function setHighlightColor(color) {
    state.settings.highlightColor = color;
    saveSettings();
    if (state.highlightEl) {
      state.highlightEl.style.backgroundColor = color;
    }
    notifyStatus();
  }

  // ---------- 頁內快捷鍵（預設空白鍵，可在 popup 修改） ----------
  // 規則：
  // - 不含 Ctrl / Alt / Meta 的快捷鍵（例如空白鍵）只在本分頁「朗讀進行中」才攔截，
  //   沒在朗讀時完全交還給網站（YouTube 播放、頁面捲動等不受影響）。
  // - 含 Ctrl / Alt / Meta 的組合鍵與網站衝突機率低，未朗讀時也可用來開始朗讀。

  function isEditableTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function matchesShortcut(event, shortcut) {
    if (!shortcut) return false;
    return (
      event.code === shortcut.code &&
      event.ctrlKey === !!shortcut.ctrlKey &&
      event.altKey === !!shortcut.altKey &&
      event.shiftKey === !!shortcut.shiftKey &&
      event.metaKey === !!shortcut.metaKey
    );
  }

  function hasStrongModifier(shortcut) {
    return !!(shortcut.ctrlKey || shortcut.altKey || shortcut.metaKey);
  }

  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // 記錄被攔截的按鍵，連同對應的 keypress / keyup 一起吞掉，
  // 避免在 keyup 才觸發動作的網站仍然收到事件。
  let swallowedCode = null;

  window.addEventListener(
    "keydown",
    (event) => {
      const shortcut = state.settings.pageShortcut;
      if (!state.settings.pageShortcutEnabled) return;
      if (!matchesShortcut(event, shortcut)) return;
      if (isEditableTarget(event.target)) return; // 使用者在輸入框輸入，不搶按鍵
      if (!state.isPlaying && !hasStrongModifier(shortcut)) return;

      swallow(event);
      swallowedCode = event.code;
      if (!event.repeat) togglePlayPause();
    },
    true
  );

  for (const type of ["keypress", "keyup"]) {
    window.addEventListener(
      type,
      (event) => {
        if (swallowedCode === null || event.code !== swallowedCode) return;
        swallow(event);
        if (type === "keyup") swallowedCode = null;
      },
      true
    );
  }

  // popup 修改設定（快捷鍵、顏色等）時即時同步到本分頁
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes[STORAGE_KEY]) return;
      state.settings = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue || {}) };
    });
  } catch (e) {
    // storage 不可用時忽略
  }

  // ---------- 與 popup 通訊 ----------

  function notifyStatus(message) {
    try {
      chrome.runtime.sendMessage({
        type: "reader-status",
        payload: {
          isPlaying: state.isPlaying,
          isPaused: state.isPaused,
          rate: state.settings.rate,
          highlightColor: state.settings.highlightColor,
          message: message || null,
        },
      });
    } catch (e) {
      // popup 未開啟時發送會失敗，忽略即可
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case "reader-toggle":
        togglePlayPause();
        sendResponse({ ok: true });
        break;
      case "reader-stop":
        stopReading();
        sendResponse({ ok: true });
        break;
      case "reader-force-stop":
        // 其他分頁已接手朗讀：只重置本分頁狀態，不可呼叫 synth.cancel()，
        // 否則會把新分頁剛排入共用佇列的語音一起取消。
        state.isPlaying = false;
        state.isPaused = false;
        state.currentIndex = -1;
        clearHighlight();
        notifyStatus();
        sendResponse({ ok: true });
        break;
      case "reader-rate-delta":
        changeRate(message.payload?.delta ?? 0);
        sendResponse({ ok: true, rate: state.settings.rate });
        break;
      case "reader-set-color":
        setHighlightColor(message.payload?.color ?? DEFAULT_SETTINGS.highlightColor);
        sendResponse({ ok: true });
        break;
      case "reader-start-from-selection":
        startReadingFromSelection();
        sendResponse({ ok: true });
        break;
      case "reader-get-status":
        sendResponse({
          ok: true,
          isPlaying: state.isPlaying,
          isPaused: state.isPaused,
          rate: state.settings.rate,
          highlightColor: state.settings.highlightColor,
        });
        break;
      default:
        break;
    }
    return true;
  });

  // ---------- 初始化 ----------

  loadSettings();
})();
