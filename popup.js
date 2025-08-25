// popup.js
const runAllBtn     = document.getElementById("runAll");
const runActiveBtn  = document.getElementById("runActive");
const closeAfter    = document.getElementById("closeAfter");
const closeNonVideo = document.getElementById("closeNonVideo");
const logEl         = document.getElementById("log");
const summaryEl     = document.getElementById("summary");

function log(line) {
  const div = document.createElement("div");
  div.textContent = line;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

async function run(type) {
  logEl.textContent = "";
  summaryEl.textContent = "Working…";
  const options = {
    closeOnSuccess: closeAfter.checked,
    closeNonVideo : closeNonVideo.checked,
  };

  const msgType = type === "active" ? "RUN_ACTIVE" : "RUN";
  const res = await chrome.runtime.sendMessage({ type: msgType, options }).catch(e => ({ ok:false, error:String(e) }));

  if (!res?.ok) {
    summaryEl.textContent = `Error: ${res?.error || "Unknown"}`;
    return;
  }

  const r = res.res;
  summaryEl.textContent = `Processed ${r.processed} (added ${r.success}, closed ${r.closed}, skipped ${r.skipped}, errors ${r.errors}). Found ${r.candidateCount} candidate tab(s).`;

  for (const d of r.details) {
    if (d.status === "added") {
      log(`✔ Added: ${d.url} ${d.via ? `(via ${d.via})` : ""}`);
    } else if (d.status === "closed_non_video") {
      log(`• Closed non-video: ${d.url}`);
    } else if (d.status === "skipped_non_video") {
      log(`• Skipped non-video: ${d.url}`);
    } else if (d.status === "skipped") {
      log(`• Skipped: ${d.url} — ${d.reason || ""}`);
    } else if (d.status === "error") {
      log(`✖ Error: ${d.url} — ${d.error}`);
    } else {
      log(`• ${d.status || "info"}: ${d.url}`);
    }
  }
}

runAllBtn.addEventListener("click", () => run("all"));
runActiveBtn.addEventListener("click", () => run("active"));
