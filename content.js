(() => {
  const MEETING_CODE_REGEX = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
  const MORE_OPTIONS_LABELS = ["その他", "More options"];
  const MENU_RECORD_LABELS = ["会議の記録", "Meeting records", "Recording"];
  const START_RECORDING_LABELS = ["録画を開始", "Start recording"];
  const START_TRANSCRIPTION_LABELS = ["文字起こしを開始", "Start transcription"];

  if (!MEETING_CODE_REGEX.test(window.location.pathname)) {
    return;
  }

  const logInfo = (message, data) => {
    if (data !== undefined) {
      console.info("[Meet Recording Reminder]", message, data);
      return;
    }
    console.info("[Meet Recording Reminder]", message);
  };

  const logWarn = (message, error) => {
    if (error !== undefined) {
      console.warn("[Meet Recording Reminder]", message, error);
      return;
    }
    console.warn("[Meet Recording Reminder]", message);
  };

  const safeSessionStorageGetRaw = (key) => {
    try {
      return sessionStorage.getItem(key);
    } catch (error) {
      logWarn("sessionStorage access failed. Falling back to in-memory state.", error);
      return null;
    }
  };

  const safeSessionStorageSetRaw = (key, value) => {
    try {
      sessionStorage.setItem(key, value);
      return true;
    } catch (error) {
      logWarn("sessionStorage write failed. Falling back to in-memory state.", error);
      return false;
    }
  };

  const tabSessionId = (() => {
    const key = "meetRecordingReminderTabId";
    let value = safeSessionStorageGetRaw(key);
    if (!value) {
      value = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const stored = safeSessionStorageSetRaw(key, value);
      if (!stored) {
        logInfo("Using in-memory tab session id.", value);
      }
    }
    return value;
  })();

  const state = {
    joinedDetected: false,
    overlayVisible: false,
    guideActive: false,
    confirmed: false,
    observers: [],
    guide: {
      overlay: null,
      tooltip: null,
      highlights: [],
    },
  };

  const memoryState = new Map();

  const safeSessionStorageGet = (key) => {
    try {
      return sessionStorage.getItem(key) === "true";
    } catch (error) {
      logWarn("sessionStorage access failed. Falling back to in-memory state.", error);
      return memoryState.get(key) || false;
    }
  };

  const safeSessionStorageSet = (key, value) => {
    try {
      sessionStorage.setItem(key, value ? "true" : "false");
    } catch (error) {
      logWarn("sessionStorage write failed. Falling back to in-memory state.", error);
      memoryState.set(key, Boolean(value));
    }
  };

  const storage = {
    async get(key) {
      if (chrome?.storage?.session) {
        try {
          const result = await chrome.storage.session.get(key);
          return result[key];
        } catch (error) {
          logWarn("chrome.storage.session.get failed. Falling back to sessionStorage.", error);
          return safeSessionStorageGet(key);
        }
      }
      return safeSessionStorageGet(key);
    },
    async set(key, value) {
      if (chrome?.storage?.session) {
        try {
          await chrome.storage.session.set({ [key]: value });
          return;
        } catch (error) {
          logWarn("chrome.storage.session.set failed. Falling back to sessionStorage.", error);
          safeSessionStorageSet(key, value);
          return;
        }
      }
      safeSessionStorageSet(key, value);
    },
  };

  const sessionKey = `meetRecordingReminderConfirmed:${tabSessionId}:${window.location.pathname}`;

  const normalizedText = (value) => value?.replace(/\s+/g, " ").trim() || "";

  const matchesText = (element, labels) => {
    const text = normalizedText(element.textContent);
    return labels.some((label) => text.includes(label));
  };

  const matchesAria = (element, labels) => {
    const label = normalizedText(element.getAttribute("aria-label"));
    return labels.some((value) => label.includes(value));
  };

  const isVisible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const findMoreOptionsButton = () => {
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"]')
    );
    return candidates.find(
      (el) => matchesAria(el, MORE_OPTIONS_LABELS) && isVisible(el)
    );
  };

  const findControlBarSignals = () => {
    const buttons = Array.from(
      document.querySelectorAll('button, [role="button"]')
    );
    const labels = [
      "microphone",
      "camera",
      "マイク",
      "カメラ",
      "ミュート",
      "Mute",
    ];
    return buttons.some((el) => matchesAria(el, labels) && isVisible(el));
  };

  const isJoined = () => Boolean(findMoreOptionsButton() || findControlBarSignals());

  const observeDom = (callback) => {
    const observer = new MutationObserver(callback);
    observer.observe(document.body, { childList: true, subtree: true });
    state.observers.push(observer);
    return observer;
  };

  const disconnectObservers = () => {
    state.observers.forEach((observer) => observer.disconnect());
    state.observers = [];
  };

  const createOverlay = () => {
    if (state.overlayVisible) return;

    const root = document.createElement("div");
    root.id = "meet-recording-reminder-root";

    const modal = document.createElement("div");
    modal.id = "meet-recording-reminder-modal";
    modal.innerHTML = `
      <h2>録画と文字起こしを開始しましたか？</h2>
      <p>この会議では毎回、録画と文字起こしを開始してください。</p>
      <div id="meet-recording-checkboxes">
        <label><input type="checkbox" id="meet-recording-check-record" /> 録画を開始した</label>
        <label><input type="checkbox" id="meet-recording-check-trans" /> 文字起こしを開始した</label>
      </div>
      <div id="meet-recording-reminder-actions">
        <button class="meet-recording-button meet-recording-primary" id="meet-recording-start-guide">開始する（手順を表示）</button>
        <button class="meet-recording-button meet-recording-secondary meet-recording-disabled" id="meet-recording-confirm" disabled>開始した（閉じる）</button>
      </div>
      <button id="meet-recording-minimize">最小化</button>
    `;

    root.appendChild(modal);
    document.body.appendChild(root);

    const banner = document.createElement("div");
    banner.id = "meet-recording-reminder-banner";
    banner.innerHTML = `
      録画と文字起こしの確認を忘れずに。
      <button id="meet-recording-restore">再表示</button>
    `;
    document.body.appendChild(banner);

    const checkRecord = modal.querySelector("#meet-recording-check-record");
    const checkTrans = modal.querySelector("#meet-recording-check-trans");
    const confirmButton = modal.querySelector("#meet-recording-confirm");
    const minimizeButton = modal.querySelector("#meet-recording-minimize");
    const startGuideButton = modal.querySelector("#meet-recording-start-guide");
    const restoreButton = banner.querySelector("#meet-recording-restore");

    const updateConfirmState = () => {
      const enabled = checkRecord.checked && checkTrans.checked;
      confirmButton.disabled = !enabled;
      confirmButton.classList.toggle("meet-recording-disabled", !enabled);
    };

    checkRecord.addEventListener("change", updateConfirmState);
    checkTrans.addEventListener("change", updateConfirmState);

    startGuideButton.addEventListener("click", () => {
      startGuide();
    });

    confirmButton.addEventListener("click", async () => {
      if (confirmButton.disabled) return;
      state.confirmed = true;
      await storage.set(sessionKey, true);
      hideOverlay();
      cleanupGuide();
      disconnectObservers();
    });

    minimizeButton.addEventListener("click", () => {
      if (minimizeButton.dataset.enabled !== "true") return;
      root.style.display = "none";
      banner.style.display = "flex";
    });

    restoreButton.addEventListener("click", () => {
      root.style.display = "flex";
      banner.style.display = "none";
    });

    setTimeout(() => {
      minimizeButton.style.display = "inline-flex";
      minimizeButton.dataset.enabled = "true";
    }, 60000);

    state.overlayVisible = true;
  };

  const hideOverlay = () => {
    const root = document.getElementById("meet-recording-reminder-root");
    const banner = document.getElementById("meet-recording-reminder-banner");
    if (root) root.remove();
    if (banner) banner.remove();
    state.overlayVisible = false;
  };

  const cleanupGuide = () => {
    if (!state.guideActive) return;
    if (state.guide.overlay) state.guide.overlay.remove();
    state.guide = { overlay: null, tooltip: null, highlights: [] };
    state.guideActive = false;
  };

  const positionTooltip = (tooltip, target) => {
    const rect = target.getBoundingClientRect();
    const top = rect.bottom + 12;
    const left = Math.min(rect.left, window.innerWidth - 300);
    tooltip.style.top = `${Math.min(top, window.innerHeight - 120)}px`;
    tooltip.style.left = `${Math.max(left, 16)}px`;
  };

  const showGuideStep = ({ targets, title, body, note }) => {
    cleanupGuide();
    const overlay = document.createElement("div");
    overlay.id = "meet-recording-guide";

    const tooltip = document.createElement("div");
    tooltip.id = "meet-recording-tooltip";
    tooltip.innerHTML = `
      <strong>${title}</strong>
      <div>${body}</div>
      ${note ? `<div class="meet-recording-guide-note">${note}</div>` : ""}
    `;

    overlay.appendChild(tooltip);
    document.body.appendChild(overlay);

    const highlights = targets.map((target) => {
      const rect = target.getBoundingClientRect();
      const highlight = document.createElement("div");
      highlight.className = "meet-recording-highlight";
      highlight.style.top = `${rect.top - 6}px`;
      highlight.style.left = `${rect.left - 6}px`;
      highlight.style.width = `${rect.width + 12}px`;
      highlight.style.height = `${rect.height + 12}px`;
      overlay.appendChild(highlight);
      return highlight;
    });

    positionTooltip(tooltip, targets[0]);

    state.guide = { overlay, tooltip, highlights };
    state.guideActive = true;
  };

  const waitForElement = (finder, onFound) => {
    const existing = finder();
    if (existing) {
      onFound(existing);
      return null;
    }
    const observer = observeDom(() => {
      const next = finder();
      if (next) {
        observer.disconnect();
        onFound(next);
      }
    });
    return observer;
  };

  const startGuide = () => {
    const moreButton = findMoreOptionsButton();
    if (!moreButton) {
      showGuideStep({
        targets: [document.body],
        title: "手順 1",
        body: "画面右下付近のその他のオプション（︙）を探してください。",
        note: "表示がまだ準備中の可能性があります。",
      });
      return;
    }

    showGuideStep({
      targets: [moreButton],
      title: "手順 1",
      body: "「その他のオプション（︙）」をクリックします。",
    });

    const handleMoreClick = () => {
      moreButton.removeEventListener("click", handleMoreClick);
      waitForMenu();
    };

    moreButton.addEventListener("click", handleMoreClick, { once: true });
  };

  const findMenuItem = () => {
    const candidates = Array.from(
      document.querySelectorAll('[role="menuitem"], button, [role="button"]')
    );
    return candidates.find((el) => matchesText(el, MENU_RECORD_LABELS) && isVisible(el));
  };

  const waitForMenu = () => {
    waitForElement(findMenuItem, (menuItem) => {
      showGuideStep({
        targets: [menuItem],
        title: "手順 2",
        body: "メニューから「会議の記録 / Recording」をクリックします。",
      });

      const handleMenuClick = () => {
        menuItem.removeEventListener("click", handleMenuClick);
        waitForRecordsPanel();
      };
      menuItem.addEventListener("click", handleMenuClick, { once: true });
    });
  };

  const findRecordButtons = () => {
    const buttons = Array.from(
      document.querySelectorAll('button, [role="button"]')
    ).filter(isVisible);
    const recording = buttons.find((el) => matchesText(el, START_RECORDING_LABELS));
    const transcription = buttons.find((el) => matchesText(el, START_TRANSCRIPTION_LABELS));
    if (recording || transcription) {
      return [recording, transcription].filter(Boolean);
    }
    return null;
  };

  const waitForRecordsPanel = () => {
    waitForElement(findRecordButtons, (targets) => {
      showGuideStep({
        targets,
        title: "手順 3",
        body: "録画と文字起こしを開始してください。",
        note: "「録画を開始」「文字起こしを開始」をそれぞれクリックします。",
      });
    });
  };

  const maybeShowOverlay = async () => {
    const confirmed = await storage.get(sessionKey);
    if (confirmed) {
      state.confirmed = true;
      return;
    }
    createOverlay();
  };

  const checkJoined = async () => {
    if (state.joinedDetected) return;
    if (isJoined()) {
      state.joinedDetected = true;
      await maybeShowOverlay();
      disconnectObservers();
    }
  };

  const init = () => {
    checkJoined();
    observeDom(() => {
      checkJoined();
    });
  };

  init();
})();
