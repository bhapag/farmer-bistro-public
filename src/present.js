// Presentation mode (?present): a small control bar that first downloads every full-size frame
// of the current frame set into the browser's HTTP cache (not decoded, so memory stays bounded;
// the player still decodes only its window), then plays the real interactive scroll story by
// scrolling the page at a steady pace. Replay returns to the top and plays again. Touching the
// wheel, keyboard or screen during playback hands control back to the visitor.
const SECONDS = 40;                       // story length when played (~16 story positions a second)
const RAMP = 0.1;                         // share of the time spent speeding up / slowing down
const PARALLEL = 6;

export async function initPresent() {
  const bar = document.createElement("div");
  bar.className = "present";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Presentation controls");
  bar.innerHTML = `<span class="present__label">Presentation mode</span>
    <span class="present__status" aria-live="polite">Preparing…</span>
    <button type="button" class="btn btn--primary present__play" disabled>Play demo</button>`;
  document.body.append(bar);
  const status = bar.querySelector(".present__status"), play = bar.querySelector(".present__play");

  // wait for the player (it publishes window.__story once it has chosen a frame set)
  const story = await new Promise((ok) => { const t = setInterval(() => { if (window.__story) { clearInterval(t); ok(window.__story()); } }, 100); setTimeout(() => { clearInterval(t); ok(null); }, 20000); });
  if (!story) { status.textContent = "Scroll story unavailable on this device: the page works as usual."; return; }
  const manifest = await fetch("/media/manifest.json").then((r) => r.json()).catch(() => null);
  const set = manifest && Object.values(manifest.sets).find((s) => s.dir === story.dir);
  const urls = set ? Array.from({ length: set.count }, (_, i) => `${set.dir}/${String(i).padStart(4, "0")}.webp`) : [];
  let done = 0, failed = 0;
  const next = async () => {
    while (urls.length) {
      const u = urls.shift();
      try { const r = await fetch(u, { priority: "low" }); if (!r.ok) failed++; await r.arrayBuffer(); } catch { failed++; }
      done++; status.textContent = `Preparing ${done} / ${set.count}`;
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, next));
  status.textContent = failed ? `Ready (${failed} frames will load as needed)` : "Ready";
  play.disabled = false;

  let raf = 0;
  const stop = () => { cancelAnimationFrame(raf); raf = 0; play.textContent = "Replay"; };
  for (const ev of ["wheel", "touchstart", "keydown"]) addEventListener(ev, (e) => { if (raf && !bar.contains(e.target)) stop(); }, { passive: true });
  play.addEventListener("click", () => {
    const st = document.getElementById("story");
    const end = st.offsetTop + st.offsetHeight - innerHeight;
    scrollTo(0, 0);
    let t0 = 0;
    const step = (t) => {
      t0 ||= t;
      const k = Math.min(1, (t - t0) / (SECONDS * 1000));
      // steady speed with short ramps at both ends: an ease-in-out peaks at twice the mean speed,
      // faster than full-size frames decode, so the middle would show previews
      const v = 1 / (1 - RAMP);
      const x = k < RAMP ? v * k * k / (2 * RAMP) : k > 1 - RAMP ? 1 - v * (1 - k) ** 2 / (2 * RAMP) : v * (k - RAMP / 2);
      scrollTo(0, Math.round(x * end));
      if (k < 1) raf = requestAnimationFrame(step); else stop();
    };
    play.textContent = "Playing…";
    setTimeout(() => { raf = requestAnimationFrame(step); }, 400);
  });
}
