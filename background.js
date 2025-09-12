// background.js — MV3 service worker
// Adds YouTube videos (watch + shorts) to Watch Later with a verified flow.
// Shorts handled IN-PLACE. Verifies by reopening dialog. Optionally closes non-video YT tabs.
// Focuses each YT tab before running, and waits for tab closure before moving on.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- URL helpers ----------
function extractVideoIdFromUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, "");
    if ((host.endsWith("youtube.com") || host === "music.youtube.com") && url.pathname === "/watch")
      return url.searchParams.get("v");
    if (host.endsWith("youtube.com") && url.pathname.startsWith("/shorts/"))
      return url.pathname.split("/")[2] || null;
    if (host === "youtu.be")
      return url.pathname.slice(1) || null;
  } catch {}
  return null;
}

function isYouTubeUrl(u) {
  try {
    const { hostname } = new URL(u);
    return /(^|\.)youtube\.com$/.test(hostname) || hostname === "youtu.be" || hostname === "music.youtube.com";
  } catch {
    return false;
  }
}

// ---------- helpers ----------
async function waitForTabClosed(tabId, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      await chrome.tabs.get(tabId); // still exists
    } catch {
      return true; // thrown = tab is gone
    }
    await sleep(100);
  }
  return false;
}

async function ensureFocused(tab) {
  try {
    if (tab.windowId != null) {
      const w = await chrome.windows.get(tab.windowId, { populate: false });
      if (!w.focused) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    }
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
    }
  } catch {
    // best effort; continue
  }
}

// ---------- Per-tab runner (executes in the page) ----------
async function injectAndRun(tabId, opts) {
  const {
    closeOnSuccess = true,
    // Timings (ms)
    delayOpen   = 2474,
    delayClick  = 2474,
    delayClose  = 2474,
    delayReopen = 4747,
    maxAttempts = 7,
    postRefreshDelay = 2000,
  } = opts || {};

  const runner = async (timing) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const norm  = (s) => (s || "").trim().toLowerCase();
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };

    const waitFor = async (sel, timeout = 9000, root = document) => {
      const t0 = performance.now();
      while (performance.now() - t0 < timeout) {
        const el = root.querySelector(sel);
        if (el) return el;
        await sleep(100);
      }
      return null;
    };

    const isShorts = location.pathname.startsWith("/shorts/");
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

    // ---- Common: checkbox & WL finders ----
    const isChecked = (opt) => {
      if (!opt) return false;
      const cb = opt.querySelector("tp-yt-paper-checkbox, #checkbox");
      const aria = cb?.getAttribute("aria-checked");
      const checked = cb?.hasAttribute("checked");
      const sel = opt.getAttribute("aria-selected");
      return aria === "true" || checked || sel === "true";
    };
    const findWLOptionIn = (dlg) => {
      const opts = dlg.querySelectorAll("ytd-playlist-add-to-option-renderer");
      for (const o of opts) {
        if (norm(o.textContent).includes("watch later")) return o;
      }
      return null;
    };

    // ---- OPEN SAVE DIALOG (watch) ----
    const openSaveDialogWatch = async () => {
      const meta = await waitFor("ytd-watch-metadata", 9000);
      if (!meta) return { dialog: null, via: "watch", error: "Metadata bar not found" };

      const actionHosts = [
        meta,
        meta.querySelector("#actions"),
        document.querySelector("ytd-watch-metadata #actions"),
        document.querySelector("ytd-watch-metadata ytd-menu-renderer"),
      ].filter(Boolean);

      window.scrollBy({ top: 1, behavior: "instant" }); await sleep(60);
      window.scrollBy({ top: -1, behavior: "instant" });

      const findUnderSaveButton = () => {
        const candidates = new Set();
        for (const host of actionHosts) {
          for (const el of host.querySelectorAll("button, a, ytd-button-renderer button, ytd-toggle-button-renderer button")) {
            candidates.add(el);
          }
        }
        const bad = ["share", "thanks", "clip", "download", "join", "like", "dislike", "subscribe"];
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          const s = norm((el.textContent || "") + " " + (el.getAttribute("aria-label") || ""));
          if (!s.includes("save")) continue;
          if (bad.some(w => s.includes(w))) continue;
          return el;
        }
        return null;
      };

      const findKebabButton = () => {
        const btns = meta.querySelectorAll("yt-icon-button button, #button-shape button");
        for (const b of btns) {
          const al = norm(b.getAttribute("aria-label"));
          if (/more|more actions|options|menu/.test(al)) return b;
        }
        return null;
      };

      const under = findUnderSaveButton();
      if (under) {
        under.scrollIntoView({ block: "center" });
        under.click();
        const dlg = await waitFor("ytd-add-to-playlist-renderer", 7000);
        if (dlg) return { dialog: dlg, via: "under" };
      }

      const kebab = findKebabButton();
      if (!kebab) return { dialog: null, via: "watch", error: "No Save or kebab menu" };
      kebab.click();
      await sleep(450);
      const popup = await waitFor("ytd-menu-popup-renderer", 5000);
      if (!popup) return { dialog: null, via: "kebab", error: "Menu did not open" };

      const items = popup.querySelectorAll("tp-yt-paper-item, ytd-menu-navigation-item-renderer, ytd-menu-service-item-renderer");
      let saveItem = null;
      for (const it of items) {
        if (norm(it.textContent).includes("save")) { saveItem = it; break; }
      }
      if (!saveItem) return { dialog: null, via: "kebab", error: "No 'Save' in kebab menu" };
      saveItem.click();

      const dlg2 = await waitFor("ytd-add-to-playlist-renderer", 7000);
      return { dialog: dlg2, via: "kebab" };
    };

    // ---- OPEN SAVE DIALOG (shorts) ----
    const openSaveDialogShorts = async () => {
      const headerOrOverlay = await waitFor("ytd-reel-player-header-renderer, ytd-reel-player-overlay-renderer, ytd-reel-video-renderer", 3500);
      if (!headerOrOverlay) {
        location.reload();
        await new Promise(r => setTimeout(r, timing.postRefreshDelay || 2000));
      }

      const overlay = await waitFor("ytd-reel-player-overlay-renderer, ytd-reel-video-renderer, ytd-reel-player-header-renderer", 9000);
      if (!overlay) return { dialog: null, via: "shorts", error: "Shorts overlay not found" };

      const findHeaderKebab = () => {
        const scopes = [
          document.querySelector("ytd-reel-player-header-renderer"),
          overlay,
          document
        ].filter(Boolean);

        for (const root of scopes) {
          const query =
            "ytd-reel-player-header-renderer ytd-menu-renderer yt-icon-button button," +
            "ytd-reel-player-header-renderer #button-shape button," +
            "ytd-reel-player-overlay-renderer ytd-menu-renderer yt-icon-button button," +
            "ytd-reel-player-overlay-renderer #button-shape button," +
            "yt-icon-button button[aria-label], #button-shape button[aria-label]";
          const btns = root.querySelectorAll(query);
          for (const b of btns) {
            const al = norm(b.getAttribute("aria-label"));
            if (!al) continue;
            if (/(more|more actions|options|menu)/.test(al) && isVisible(b)) return b;
          }
        }
        return null;
      };

      const findDirectSaveAction = () => {
        const candidates = document.querySelectorAll(
          "ytd-reel-player-overlay-renderer button, ytd-reel-player-overlay-renderer a, button, a"
        );
        for (const el of candidates) {
          const txt = norm((el.textContent || "") + " " + (el.getAttribute("aria-label") || ""));
          if (isVisible(el) && (txt.includes("save to playlist") || txt.includes("save"))) return el;
        }
        return null;
      };

      const directSave = findDirectSaveAction();
      if (directSave) {
        directSave.click();
        const dlg = await waitFor("ytd-add-to-playlist-renderer", 7000);
        if (dlg) return { dialog: dlg, via: "shorts_direct" };
      }

      const kebabBtn = findHeaderKebab();
      if (!kebabBtn) return { dialog: null, via: "shorts", error: "Shorts kebab not found" };

      kebabBtn.scrollIntoView({ block: "center" });
      kebabBtn.click();
      await sleep(500);

      const popup = await waitFor("ytd-menu-popup-renderer", 6000);
      if (!popup) return { dialog: null, via: "shorts", error: "Shorts menu did not open" };

      const items = popup.querySelectorAll("tp-yt-paper-item, ytd-menu-navigation-item-renderer, ytd-menu-service-item-renderer");
      let saveItem = null;
      for (const it of items) {
        const t = norm(it.textContent);
        if (t.includes("save to playlist") || t.includes("save")) { saveItem = it; break; }
      }
      if (!saveItem) return { dialog: null, via: "shorts", error: "No 'Save' in Shorts menu" };

      saveItem.click();
      const dlg2 = await waitFor("ytd-add-to-playlist-renderer", 7000);
      return { dialog: dlg2, via: "shorts" };
    };

    const openSaveDialog = async () => {
      return location.pathname.startsWith("/shorts/")
        ? openSaveDialogShorts()
        : openSaveDialogWatch();
    };

    let via = location.pathname.startsWith("/shorts/") ? "shorts" : "watch";
    for (let attempt = 1; attempt <= timing.maxAttempts; attempt++) {

      const open1 = await openSaveDialog();
      if (!open1.dialog) {
        if (attempt === timing.maxAttempts) return { ok: false, error: open1.error || "Save dialog did not appear (first open)" };
        await sleep(350);
        continue;
      }
      via = open1.via || via;
      await sleep(timing.delayOpen);

      const wl1 = findWLOptionIn(open1.dialog);
      if (!wl1) {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(350);
        if (attempt === timing.maxAttempts) return { ok: false, error: "Could not find 'Watch later' (first open)" };
        continue;
      }

      if (!isChecked(wl1)) {
        (wl1.querySelector("tp-yt-paper-checkbox, #checkbox") || wl1).click();
      }
      await sleep(timing.delayClick);

      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(timing.delayClose);

      const open2 = await openSaveDialog();
      if (!open2.dialog) {
        if (attempt === timing.maxAttempts) return { ok: false, error: open2.error || "Save dialog did not appear (second open)" };
        await sleep(350);
        continue;
      }
      await sleep(timing.delayReopen);

      const wl2 = findWLOptionIn(open2.dialog);
      if (!wl2) {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(350);
        if (attempt === timing.maxAttempts) return { ok: false, error: "Could not find 'Watch later' (second open)" };
        continue;
      }

      const confirmed = isChecked(wl2);

      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(220);

      if (confirmed) {
        return { ok: true, via, confirmed: true, attempts: attempt };
      }

      await sleep(350);
    }

    return { ok: false, error: "Watch later not confirmed after retries", via, confirmed: false };
  };

  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    func: runner,
    args: [{
      delayOpen, delayClick, delayClose, delayReopen, maxAttempts, postRefreshDelay
    }]
  });

  const result = inj?.result || { ok: false, error: "No result from content script" };

  if (result.ok && closeOnSuccess) {
    try { await chrome.tabs.remove(tabId); } catch {}
  }
  return result;
}

// ---------- Batch processor ----------
async function processTabs({
  onlyActive = false,
  closeOnSuccess = true,
  closeNonVideo = true,
  activateEachTab = true,
  focusWindow = true,
  activationDelay = 500,
} = {}) {

  let tabs = [];
  if (onlyActive) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t) tabs = [t];
  } else {
    tabs = await chrome.tabs.query({});
  }

  const ytTabs = tabs.filter(t => isYouTubeUrl(t.url || ""));

  const res = {
    processed: 0, success: 0, closed: 0, skipped: 0, errors: 0,
    details: [], candidateCount: ytTabs.length
  };

  for (const t of ytTabs) {
    const url = t.url || "";
    const vid = extractVideoIdFromUrl(url);

    // Non-video YouTube tabs (e.g., homepage, history, search)
    if (!vid) {
      if (closeNonVideo) {
        try { await chrome.tabs.remove(t.id); res.closed++; } catch {}
        await waitForTabClosed(t.id, 2000); // ensure it's gone before moving on
        res.details.push({ tabId: t.id, url, status: "closed_non_video" });
      } else {
        res.details.push({ tabId: t.id, url, status: "skipped_non_video" });
      }
      res.skipped++;
      continue;
    }

    if (activateEachTab) {
      await ensureFocused(t);
      await sleep(activationDelay);
    }

    try {
      const r = await injectAndRun(t.id, {
        closeOnSuccess,
        delayOpen: 2474,
        delayClick: 2474,
        delayClose: 2474,
        delayReopen: 4747,
        maxAttempts: 7,
        postRefreshDelay: 2000
      });
      res.processed++;
      if (r.ok) {
        if (closeOnSuccess) {
          // Wait until the tab is actually closed to avoid focusing the next tab prematurely
          await waitForTabClosed(t.id, 5000);
          res.closed++;
        }
        res.success++;
        res.details.push({ tabId: t.id, url, status: "added", via: r.via || "unknown", confirmed: !!r.confirmed, attempts: r.attempts || 1 });
      } else {
        res.errors++;
        res.details.push({ tabId: t.id, url, status: "error", error: r.error });
      }
    } catch (e) {
      res.processed++; res.errors++;
      res.details.push({ tabId: t.id, url, status: "error", error: String(e) });
    }

    await sleep(220);
  }

  return res;
}

// ---------- Message bridge ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "RUN") {
      const r = await processTabs({
        onlyActive: false,
        closeOnSuccess: !!msg.options?.closeOnSuccess,
        closeNonVideo: !!msg.options?.closeNonVideo,
        activateEachTab: true,
        focusWindow: true,
        activationDelay: 500
      });
      sendResponse({ ok: true, res: r });
    } else if (msg?.type === "RUN_ACTIVE") {
      const r = await processTabs({
        onlyActive: true,
        closeOnSuccess: !!msg.options?.closeOnSuccess,
        closeNonVideo: !!msg.options?.closeNonVideo,
        activateEachTab: true,
        focusWindow: true,
        activationDelay: 500
      });
      sendResponse({ ok: true, res: r });
    }
  })();
  return true;
});
