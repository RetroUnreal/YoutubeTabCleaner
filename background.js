// background.js — MV3 service worker
// Adds YouTube videos (watch + shorts) to Watch Later with a verified flow.
// Supports BOTH old "ytd-playlist-add-to-option-renderer" AND new "toggleable-list-item-view-model" Save UI.
// Optional: convert Shorts URLs to normal /watch?v=... before running (more stable).
// Optional: reload-if-UI-missing with configurable post-reload delay.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- URL helpers ----------
function extractVideoIdFromUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, "");

    if ((host.endsWith("youtube.com") || host === "music.youtube.com") && url.pathname === "/watch")
      return url.searchParams.get("v");

    if (host.endsWith("youtube.com") && url.pathname.startsWith("/shorts/"))
      return url.pathname.split("/")[2] || null;

    if (host === "youtu.be") return url.pathname.slice(1) || null;
  } catch {}
  return null;
}

function isYoutubeUrl(u) {
  return /(^|\.)youtube\.com\/|(^|\.)youtu\.be\//i.test(u || "");
}

function isShortsUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, "");
    return host.endsWith("youtube.com") && url.pathname.startsWith("/shorts/");
  } catch {}
  return false;
}

function buildWatchUrlFromId(id) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

async function updateTabUrlAndWait(tabId, url, delayAfterNavigateMs) {
  await chrome.tabs.update(tabId, { url });

  // Wait for "complete" once (best-effort), then additional delay.
  try {
    await new Promise((resolve) => {
      const onUpdated = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);

      // Safety: resolve anyway if we never get complete (some YT pages keep streaming)
      setTimeout(() => {
        try {
          chrome.tabs.onUpdated.removeListener(onUpdated);
        } catch {}
        resolve();
      }, Math.max(8000, delayAfterNavigateMs + 2000));
    });
  } catch {}

  if (delayAfterNavigateMs > 0) await sleep(delayAfterNavigateMs);
}

// ---------- Per-tab runner (executes in the page) ----------
async function injectAndRun(tabId, opts) {
  const {
    closeOnSuccess = true,

    // Timings (ms)
    delayOpen = 1200,
    delayClick = 1200,
    delayClose = 700,
    delayReopen = 1400,

    // Reload handling (in-page)
    reloadIfUIMissing = true,
    delayAfterReload = 2000,

    maxAttempts = 10,
  } = opts || {};

  const runner = async (timing) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

    const isVisible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const clickSafe = (el) => {
      if (!el) return false;
      try {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        el.click();
        return true;
      } catch {
        try {
          el.click();
          return true;
        } catch {}
      }
      return false;
    };

    const pressEsc = () => {
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      } catch {}
    };

    const pauseAndMute = () => {
    const v = document.querySelector("video");
    if (!v) return;
    try { v.muted = true; } catch {}
    try { v.autoplay = false; } catch {}
    try { v.pause(); } catch {}
  };


    const waitForAny = async (selectors, timeout = 9000, root = document) => {
      const t0 = performance.now();
      while (performance.now() - t0 < timeout) {
        for (const sel of selectors) {
          const el = root.querySelector(sel);
          if (el) return el;
        }
        await sleep(120);
      }
      return null;
    };

    const getVid = () => {
      try {
        const u = new URL(location.href);
        if (u.searchParams.get("v")) return u.searchParams.get("v");
        if (u.hostname === "youtu.be") return u.pathname.slice(1);
        if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
      } catch {}
      return null;
    };

    const vid = getVid();
    if (!vid) return { ok: false, error: "No video detected" };
    pauseAndMute();

    // ---- “Save to…” dialog detection (YT keeps changing wrappers) ----
    const waitForSaveDialog = async (timeout = 9000) => {
      // Old UI uses ytd-add-to-playlist-renderer / ytd-playlist-add-to-option-renderer
      // New UI uses toggleable-list-item-view-model rows in a dialog
      return await waitForAny(
        [
          "ytd-add-to-playlist-renderer",
          "tp-yt-paper-dialog ytd-add-to-playlist-renderer",
          "tp-yt-paper-dialog ytd-playlist-add-to-option-renderer",
          "ytd-popup-container ytd-add-to-playlist-renderer",
          "ytd-popup-container ytd-playlist-add-to-option-renderer",

          // NEW UI markers:
          "tp-yt-paper-dialog toggleable-list-item-view-model",
          "ytd-popup-container toggleable-list-item-view-model",
          "tp-yt-paper-dialog [role='dialog'] toggleable-list-item-view-model",
        ],
        timeout
      );
    };

    const getDialogRootFromAnyNode = (node) => {
      if (!node) return null;
      if (node.matches?.("ytd-add-to-playlist-renderer")) return node;

      const dlg =
        node.closest?.("ytd-add-to-playlist-renderer") ||
        node.closest?.("tp-yt-paper-dialog") ||
        node.closest?.("[role='dialog']") ||
        node.closest?.("ytd-popup-container") ||
        node.closest?.("body");

      return dlg || document;
    };

    // ---- Find “Watch later” row (supports old + new UI) ----
    const findWatchLaterRow = (dlgRoot) => {
      const root = dlgRoot || document;

      // NEW UI: prefer the inner yt-list-item-view-model (it usually carries aria-pressed)
      const items = root.querySelectorAll("yt-list-item-view-model[aria-label], yt-list-item-view-model");
      for (const it of items) {
        const al = norm(it.getAttribute?.("aria-label"));
        const tx = norm(it.textContent);
        if ((al && al.includes("watch later")) || tx.includes("watch later")) return it;
      }

      // OLD UI fallback
      const oldRows = root.querySelectorAll("ytd-playlist-add-to-option-renderer");
      for (const r of oldRows) {
        if (norm(r.textContent).includes("watch later")) return r;
      }

      return null;
    };


    // ---- Checked detection (supports old + new UI) ----
    const isChecked = (row) => {
      if (!row) return false;

      const ap = row.getAttribute?.("aria-pressed");
      if (ap === "true") return true;

      const sel = row.getAttribute?.("aria-selected");
      if (sel === "true") return true;

      // Sometimes the wrapper carries the pressed/selected state
      const wrapper = row.closest?.("toggleable-list-item-view-model");
      if (wrapper) {
        const wap = wrapper.getAttribute?.("aria-pressed");
        if (wap === "true") return true;
        const wsel = wrapper.getAttribute?.("aria-selected");
        if (wsel === "true") return true;
      }

      // OLD UI checkbox style
      const cb = row.querySelector?.("tp-yt-paper-checkbox, #checkbox");
      const aria = cb?.getAttribute("aria-checked");
      if (aria === "true") return true;
      if (cb?.hasAttribute("checked")) return true;

      const pressed = row.querySelector?.("[aria-pressed='true'], [aria-checked='true'], [aria-selected='true']");
      return !!pressed;
    };



    const waitForRowsToRender = async (dlgRoot, timeout = 8000) => {
      const t0 = performance.now();
      while (performance.now() - t0 < timeout) {
        const root = dlgRoot || document;
        const hasOld = root.querySelector("ytd-playlist-add-to-option-renderer");
        const hasNew = root.querySelector("toggleable-list-item-view-model");
        if (hasOld || hasNew) return true;
        await sleep(120);
      }
      return false;
    };

    // ---- Click Watch Later robustly (supports old + new UI) ----
    const clickWatchLater = async (dlgRoot) => {
      await waitForRowsToRender(dlgRoot, 8000);

      const row = findWatchLaterRow(dlgRoot);
      if (!row) return { ok: false, reason: "WL row not found" };

      try { row.scrollIntoView({ block: "center" }); } catch {}

      // If already checked, done.
      if (isChecked(row)) return { ok: true, changed: false };

      // In the NEW UI, the click handler is usually on the *container* / row itself.
      const container =
        row.querySelector?.(".yt-list-item-view-model__container") ||
        row.querySelector?.("[role='button']") ||
        row;

      const hardClick = (el) => {
        if (!el) return false;
        try {
          // Pointer events matter on newer YT UI
          el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
          el.dispatchEvent(new PointerEvent("pointerup",   { bubbles: true, cancelable: true, pointerType: "mouse" }));
        } catch {}
        try {
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true, view: window }));
        } catch {}
        try { el.click(); return true; } catch {}
        return false;
      };

      // Try a couple times because YT sometimes attaches handlers late
      for (let i = 0; i < 3; i++) {
        hardClick(container);

        // Wait up to ~2.5s for aria-pressed to flip on the ROW
        const t0 = performance.now();
        while (performance.now() - t0 < 2500) {
          await sleep(150);
          const fresh = findWatchLaterRow(dlgRoot);
          if (fresh && isChecked(fresh)) return { ok: true, changed: true };
        }

        await sleep(250);
      }

      return { ok: false, reason: "Clicked row/container but aria-pressed did not flip" };
    };

    // ---- OPEN SAVE DIALOG (watch) ----
    const openSaveDialogWatch = async () => {
      let meta = document.querySelector("ytd-watch-metadata");
      if (!meta) meta = await waitForAny(["ytd-watch-metadata"], 7000);

      if (!meta && timing.reloadIfUIMissing) {
        location.reload();
        await sleep(timing.delayAfterReload);
        meta = await waitForAny(["ytd-watch-metadata"], 9000);
      }

      if (!meta) return { dialog: null, via: "watch", error: "Metadata bar not found" };

      const actions = meta.querySelector("#actions") || document.querySelector("ytd-watch-metadata #actions") || meta;

      const findUnderSaveButton = () => {
        const candidates = actions.querySelectorAll(
          "ytd-button-renderer button, ytd-toggle-button-renderer button, yt-button-shape button, button[aria-label]"
        );

        for (const b of candidates) {
          if (!isVisible(b)) continue;
          const al = norm(b.getAttribute("aria-label"));
          const txt = norm(b.textContent);
          const combined = `${al} ${txt}`.trim();

          if (!(combined.includes("save") || combined.includes("save to playlist"))) continue;

          // Guardrails: avoid wrong buttons
          if (
            combined.includes("like") ||
            combined.includes("dislike") ||
            combined.includes("share") ||
            combined.includes("clip") ||
            combined.includes("thanks") ||
            combined.includes("download") ||
            combined.includes("join") ||
            combined.includes("subscribe")
          )
            continue;

          return b;
        }
        return null;
      };

      const findKebabButton = () => {
        const btns = meta.querySelectorAll("yt-icon-button button[aria-label], #button-shape button[aria-label]");
        for (const b of btns) {
          const al = norm(b.getAttribute("aria-label"));
          if (!al) continue;
          if (al.includes("more") || al.includes("more actions") || al.includes("options") || al.includes("menu")) {
            if (isVisible(b)) return b;
          }
        }
        return null;
      };

      // 1) Under-video Save
      const under = findUnderSaveButton();
      if (under) {
        under.scrollIntoView({ block: "center" });
        clickSafe(under);

        const dlgAny = await waitForSaveDialog(9000);
        if (dlgAny) return { dialog: getDialogRootFromAnyNode(dlgAny), via: "under" };
      }

      // 2) Kebab → Save item
      const kebab = findKebabButton();
      if (!kebab) return { dialog: null, via: "watch", error: "No Save button and no kebab menu" };

      clickSafe(kebab);
      await sleep(450);

      const popup = await waitForAny(["ytd-menu-popup-renderer"], 6000);
      if (!popup) return { dialog: null, via: "kebab", error: "Menu did not open" };

      const items = popup.querySelectorAll(
        "ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer, tp-yt-paper-item"
      );

      let saveItem = null;
      for (const it of items) {
        const t = norm(it.textContent);
        if (t.includes("save")) {
          saveItem = it;
          break;
        }
      }
      if (!saveItem) return { dialog: null, via: "kebab", error: "No 'Save' item in kebab menu" };

      clickSafe(saveItem);

      const dlgAny2 = await waitForSaveDialog(9000);
      if (!dlgAny2) return { dialog: null, via: "kebab", error: "Save dialog did not appear" };

      return { dialog: getDialogRootFromAnyNode(dlgAny2), via: "kebab" };
    };

    // ---- OPEN SAVE DIALOG (shorts) (fallback only) ----
    const openSaveDialogShorts = async () => {
      let overlay = await waitForAny(
        ["ytd-reel-player-overlay-renderer", "ytd-reel-video-renderer", "ytd-reel-player-header-renderer"],
        9000
      );

      if (!overlay && timing.reloadIfUIMissing) {
        location.reload();
        await sleep(timing.delayAfterReload);
        overlay = await waitForAny(
          ["ytd-reel-player-overlay-renderer", "ytd-reel-video-renderer", "ytd-reel-player-header-renderer"],
          9000
        );
      }

      if (!overlay) return { dialog: null, via: "shorts", error: "Shorts UI not found" };

      const kebab = document.querySelector(
        "ytd-reel-player-header-renderer ytd-menu-renderer yt-icon-button button[aria-label]," +
          "ytd-reel-player-header-renderer #button-shape button[aria-label]"
      );

      if (!kebab || !isVisible(kebab)) return { dialog: null, via: "shorts", error: "Shorts kebab not found" };

      kebab.scrollIntoView({ block: "center" });
      clickSafe(kebab);
      await sleep(450);

      const popup = await waitForAny(["ytd-menu-popup-renderer"], 6000);
      if (!popup) return { dialog: null, via: "shorts", error: "Shorts menu did not open" };

      const items = popup.querySelectorAll(
        "ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer, tp-yt-paper-item"
      );

      let saveItem = null;
      for (const it of items) {
        const t = norm(it.textContent);
        if (t.includes("save to playlist") || t === "save" || t.includes("save")) {
          saveItem = it;
          break;
        }
      }
      if (!saveItem) return { dialog: null, via: "shorts", error: "No 'Save' / 'Save to playlist' in Shorts menu" };

      clickSafe(saveItem);

      const dlgAny = await waitForSaveDialog(9000);
      if (!dlgAny) return { dialog: null, via: "shorts", error: "Save dialog did not appear" };

      return { dialog: getDialogRootFromAnyNode(dlgAny), via: "shorts" };
    };

    const openSaveDialog = async () => {
      const isShorts = location.pathname.startsWith("/shorts/");
      return isShorts ? await openSaveDialogShorts() : await openSaveDialogWatch();
    };

    // ---- Attempt loop: open → wait → click WL → close → reopen → verify ----
    let via = location.pathname.startsWith("/shorts/") ? "shorts" : "watch";

    for (let attempt = 1; attempt <= timing.maxAttempts; attempt++) {
      // 1) First open
      pauseAndMute();
      const open1 = await openSaveDialog();
      if (!open1.dialog) {
        if (attempt === timing.maxAttempts) {
          return { ok: false, error: open1.error || "Save dialog did not appear (first open)" };
        }
        await sleep(450);
        continue;
      }

      via = open1.via || via;
      await sleep(timing.delayOpen);

      const click1 = await clickWatchLater(open1.dialog);
      if (!click1.ok) {
        pressEsc();
        await sleep(350);
        if (attempt === timing.maxAttempts) {
          return { ok: false, error: `Could not toggle Watch later: ${click1.reason || "unknown"}` };
        }
        continue;
      }

      // Close dialog
      pressEsc();
      await sleep(timing.delayClose);

      // 2) Second open (verification)
      const open2 = await openSaveDialog();
      if (!open2.dialog) {
        if (attempt === timing.maxAttempts) {
          return { ok: false, error: open2.error || "Save dialog did not appear (second open)" };
        }
        await sleep(450);
        continue;
      }

      await sleep(timing.delayReopen);

      const row2 = findWatchLaterRow(open2.dialog);
      const confirmed = row2 ? isChecked(row2) : false;

      pressEsc();
      await sleep(250);

      if (confirmed) {
        return { ok: true, via, confirmed: true, attempts: attempt };
      }

      // Not confirmed → retry
      await sleep(450);
    }

    return { ok: false, error: "Watch later not confirmed after retries", via, confirmed: false };
  };

  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    func: runner,
    args: [
      {
        delayOpen,
        delayClick,
        delayClose,
        delayReopen,
        reloadIfUIMissing,
        delayAfterReload,
        maxAttempts,
      },
    ],
  });

  const result = inj?.result || { ok: false, error: "No result from content script" };

  if (result.ok && closeOnSuccess) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {}
  }

  return result;
}

// ---------- Batch processor ----------
async function processTabs({
  onlyActive = false,
  closeOnSuccess = true,
  closeNonVideo = true,

  // Convert Shorts tabs to /watch?v=... before injecting (recommended)
  convertShortsToWatch = true,
  delayAfterNavigate = 2000,

  // Runner settings
  delayOpen = 1200,
  delayClick = 1200,
  delayClose = 700,
  delayReopen = 1400,
  delayAfterReload = 2000,
  maxAttempts = 10,
} = {}) {
  let tabs = [];
  if (onlyActive) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t) tabs = [t];
  } else {
    tabs = await chrome.tabs.query({});
  }

  // Only iterate YT tabs
  const yt = tabs.filter((t) => isYoutubeUrl(t.url || ""));
  const res = {
    processed: 0,
    success: 0,
    closed: 0,
    skipped: 0,
    errors: 0,
    details: [],
    candidateCount: yt.length,
  };

  for (const t of yt) {
    const tabId = t.id;
    const url = t.url || "";
    const vid = extractVideoIdFromUrl(url);

    if (!vid) {
      if (closeNonVideo) {
        try {
          await chrome.tabs.remove(tabId);
          res.closed++;
        } catch {}
        res.details.push({ tabId, url, status: "closed_non_video" });
      } else {
        res.details.push({ tabId, url, status: "skipped_non_video" });
      }
      res.skipped++;
      continue;
    }

    try {
      // IMPORTANT: focus the window + activate the tab (YouTube UI often fails in background tabs)
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch {}
      try { await chrome.tabs.update(tabId, { active: true }); } catch {}
      await sleep(600);

      if (convertShortsToWatch && isShortsUrl(url)) {
        const watchUrl = buildWatchUrlFromId(vid);
        if (watchUrl !== url) {
          await updateTabUrlAndWait(tabId, watchUrl, delayAfterNavigate);
        }
      }

      await chrome.tabs.update(tabId, { active: true });
      await sleep(350);

      const r = await injectAndRun(tabId, {
        closeOnSuccess,
        delayOpen,
        delayClick,
        delayClose,
        delayReopen,
        delayAfterReload,
        maxAttempts,
        reloadIfUIMissing: true,
      });

      res.processed++;

      if (r.ok) {
        res.success++;
        if (closeOnSuccess) res.closed++;
        res.details.push({
          tabId,
          url: t.url,
          status: "added",
          via: r.via || "unknown",
          confirmed: !!r.confirmed,
          attempts: r.attempts || 1,
        });
      } else {
        res.errors++;
        res.details.push({ tabId, url: t.url, status: "error", error: r.error });
      }
    } catch (e) {
      res.processed++;
      res.errors++;
      res.details.push({ tabId, url: t.url, status: "error", error: String(e) });
    }

    await sleep(250);
  }

  return res;
}

// ---------- Message bridge ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const o = msg?.options || {};

    if (msg?.type === "RUN") {
      const r = await processTabs({
        onlyActive: false,
        closeOnSuccess: !!o.closeOnSuccess,
        closeNonVideo: !!o.closeNonVideo,

        convertShortsToWatch: o.convertShortsToWatch ?? true,
        delayAfterNavigate: Number.isFinite(o.delayAfterNavigate) ? o.delayAfterNavigate : 2000,

        delayOpen: Number.isFinite(o.delayOpen) ? o.delayOpen : 1200,
        delayClick: Number.isFinite(o.delayClick) ? o.delayClick : 1200,
        delayClose: Number.isFinite(o.delayClose) ? o.delayClose : 700,
        delayReopen: Number.isFinite(o.delayReopen) ? o.delayReopen : 1400,
        delayAfterReload: Number.isFinite(o.delayAfterReload) ? o.delayAfterReload : 2000,
        maxAttempts: Number.isFinite(o.maxAttempts) ? o.maxAttempts : 10,
      });
      sendResponse({ ok: true, res: r });
    } else if (msg?.type === "RUN_ACTIVE") {
      const r = await processTabs({
        onlyActive: true,
        closeOnSuccess: !!o.closeOnSuccess,
        closeNonVideo: !!o.closeNonVideo,

        convertShortsToWatch: o.convertShortsToWatch ?? true,
        delayAfterNavigate: Number.isFinite(o.delayAfterNavigate) ? o.delayAfterNavigate : 2000,

        delayOpen: Number.isFinite(o.delayOpen) ? o.delayOpen : 1200,
        delayClick: Number.isFinite(o.delayClick) ? o.delayClick : 1200,
        delayClose: Number.isFinite(o.delayClose) ? o.delayClose : 700,
        delayReopen: Number.isFinite(o.delayReopen) ? o.delayReopen : 1400,
        delayAfterReload: Number.isFinite(o.delayAfterReload) ? o.delayAfterReload : 2000,
        maxAttempts: Number.isFinite(o.maxAttempts) ? o.maxAttempts : 10,
      });
      sendResponse({ ok: true, res: r });
    }
  })();

  return true;
});
