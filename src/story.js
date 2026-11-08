// Scroll story: one GSAP timeline, scrubbed by ScrollTrigger, drives the story position,
// the copy beats and the progress bar. Same scroll position -> same state, both directions.
//
// Frames come from a versioned manifest (/media/manifest.json):
//   { version, sets: { <name>: { dir, w, h, count, focus, fit?, zoom?, timeline } }, pick, beats }
// "timeline" lists frame ranges in story order ([from, to] or [from, to, positionsPerFrame]:
// [n, n, 16] holds a frame, [210, 229, 2] slows a fast stretch); a range may run backwards (a
// clip replayed in reverse), so one set of files serves several beats.
//
// Anything that stops the sequence from working (bad manifest, repeated frame failures, stalled
// requests) calls onFail(): main.js then switches the page to its static, still-image layout.
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);
// mobile browser bars showing/hiding resize the window but not the story (its heights are in
// svh/vh units): no ScrollTrigger refresh for them
ScrollTrigger.config({ ignoreMobileResize: true });

const UNITS = 216;                        // story length in timeline units (beats are placed on this scale)
const INK = "#120f0e";                    // page charcoal: letterbox fill on phones
const pad = (i) => String(i).padStart(4, "0");
const params = new URLSearchParams(location.search);

// Tunables. Budgets are an estimate of retained *decoded image* bytes (w*h*4 per frame), not
// total browser memory: canvas surfaces, in-flight decodes and the HTTP cache come on top.
// phone: 96 MB unless the browser reports 4 GB of memory or less (iOS reports nothing)
const BUDGET_MB = { desktop: 160, phone: 96, lowMemory: 64 };
// concurrent frame requests (the requested frame gets its own slot on top). Phones: 6, since their
// frame requests are latency-bound (~40 ms each from a warm CDN edge, ~300 ms from a cold one) and
// 3 slots left frames queueing 130-300 ms; desktops keep 3 (6 measured slower first responses on
// 1600 px frames). ?active=n for A/B tests.
const ACTIVE = { desktop: 3, phone: 6 };
const STALL_MS = 9000;                    // a request older than this is aborted and counted as failed
const MAX_TRIES = 3;                      // per frame, across evictions
const FAIL_LIMIT = 6;                     // distinct frames that exhausted their tries -> degrade
const STARVE_MS = 12000;                  // wanted frame with nothing drawable for this long -> degrade
const NEAR = 3;                           // story positions either side loaded before anything else
const MAX_SUB = 10;                       // a same-scene stand-in may be at most this many story positions away
const FULL_NEAR = 3;                      // a sharp frame this many positions away beats a preview of the exact one
const SLOW_FETCH = 120;
const SLOW_TIER = 160, FAST_TIER = 50;      // ms: switch phones to the 960 tier above / back to full below (once each way)                   // ms: full frames slower than this (smoothed) count as a slow connection
const KEEP = 24;                          // an in-flight request this close (in positions) to the target is not cancelled
const FAST = 18;                          // positions/s: above this, full-size prefetch shrinks to the target, lead and NEAR; previews carry the motion
const PV_CAP = { desktop: 40, phone: 24 }; // decoded preview frames kept (512x288: 0.56 MB each, inside the budget)

export async function initStory({ onFail = () => {} } = {}) {
  const stage = document.querySelector("[data-stage]");
  const canvas = document.querySelector("[data-canvas]");
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return onFail("canvas unavailable");

  const manifest = await loadManifest();
  if (!manifest) return onFail("manifest missing or invalid");

  let dead = false;
  const fail = (why) => { if (dead) return; dead = true; teardown(); onFail(why); };

  // phone-class devices: small screens or low reported memory
  const phone = Math.min(screen.width, screen.height) < 600 || (navigator.deviceMemory || 8) <= 4;
  const MAX_ACTIVE = Number(params.get("active")) || (phone ? ACTIVE.phone : ACTIVE.desktop);
  const lowMemory = (navigator.deviceMemory || 8) <= 4;
  const BUDGET = (Number(params.get("budget")) || (phone ? (lowMemory ? BUDGET_MB.lowMemory : BUDGET_MB.phone) : BUDGET_MB.desktop)) * 1048576;
  const pick = () => {
    const P = manifest.pick || {};
    const portrait = innerWidth / innerHeight < 0.8;
    const name = phone ? (portrait ? P.phonePortrait : P.phoneLandscape) : (portrait ? P.portrait : P.landscape);
    return manifest.sets[name] ? name : Object.keys(manifest.sets)[0];
  };

  // ------------------------------------------------------------------ frame store
  // entry: { img, state: "loading"|"ready", started, stallTimer }
  // Two numbering schemes: a *frame* is a source file index (0..count-1); a *position* is a step
  // of the story (0..order.length-1), order[position] -> frame. One frame can sit at several
  // positions (0..74 plays forward, then backward to reassemble), so loading, choosing and
  // captioning all work in positions; frame numbers are only used to fetch and dedupe files.
  let set, S, order, shotOf, sceneOf, sceneEnds, posOf, gen = 0;
  let frames = new Map();                 // frame -> entry (loading or ready): the retained set
  let desired = new Set();                // frames the current position wants retained (<= capacity)
  let queue = [];                         // frames waiting for a request slot, highest priority first
  let active = 0;
  const fails = new Map();                // `${dir}|${i}` -> failed attempts (not cancellations), survives eviction
  const retryAt = new Map();              // frame -> timer (cancelled on eviction)
  let exhausted = 0;
  let perFrame = 0, capacity = 0, nAnchors = 0, anchorPos = [], anchorSet = new Set();
  let want = 0, drawn = "", drawnFrame = -1, shown = -1, raf = 0;
  let warm = false;                       // anchors + full window only after first paint and idle
  let vel = 0, velT = 0, velPos = 0;      // smoothed story velocity, positions per second
  const speed = () => (performance.now() - velT > 150 ? 0 : vel);   // no scroll updates lately = standing still
  let fetchEma = 0, slowNet = false;
  // previews are needed only when the frames in use cannot keep up: full frames on a slow
  // connection with no lighter tier, or the 960 tier itself slower than 250 ms a frame
  const needPreview = () => slowNet && (!S?.slow && !usingSlow || (usingSlow && fetchEma > 250));      // smoothed full-frame download time; previews only matter when slow
  let starveSince = 0;
  let peak = { retained: 0, mb: 0, at: -1 };
  // loader trace for QA (window.__storyStats): one record per finished or cancelled request
  const trace = [], queuedAt = new Map();
  let wasted = 0;
  const note = (r) => { if (trace.length < 4000) trace.push(r); };

  // expand the timeline; a "shot" is one timeline entry, a "scene" a run of shots whose frames
  // continue into each other (the burger clips; then dissolve, lower, sides, lid)
  function expand(spec) {
    const o = [], shot = [], scene = [];
    let sc = 0;
    spec.timeline.forEach(([a, b, hold = 1], s) => {
      if (s && Math.abs(spec.timeline[s - 1][1] - a) > 1) sc++;
      const push = (i) => { for (let k = 0; k < hold; k++) { o.push(i); shot.push(s); scene.push(sc); } };
      const step = a <= b ? 1 : -1;
      for (let i = a; i !== b + step; i += step) push(i);
    });
    return { o, shot, scene };
  }

  // phone sets carry "slow": a 960x540 tier (scripts/build_mid.py) used once full frames prove
  // slow on this connection; the switch is sticky for the visit
  // the tier chosen earlier in this browser session is kept across reloads and re-visits, so a
  // phone on a slow connection does not start every page on frames it cannot fetch fast enough
  const remembered = (() => { try { return sessionStorage.getItem("fb-tier"); } catch { return null; } })();
  let usingSlow = remembered === "mid";
  const tier = (spec) => (usingSlow && spec.slow ? { ...spec, dir: spec.slow.dir, w: spec.slow.w, h: spec.slow.h } : spec);
  const capFor = () => {
    // the decoded preview cache comes out of the same budget
    const pvBytes = manifest.preview?.packs?.length ? (phone ? PV_CAP.phone : PV_CAP.desktop) * manifest.preview.w * manifest.preview.h * 4 : 0;
    // minus one: the requested frame may take one slot beyond capacity while it loads
    return Math.max(6, Math.floor((BUDGET - pvBytes) / perFrame) - 1);
  };
  // switch tiers: to 960 when full frames are slow, back to full when 960 frames turn out fast
  // (a cold CDN right after a deploy can make the first full frames look slow)
  let sinceSwitch = 0, switches = 0;
  function useSlow(on = true) {
    if (usingSlow === on || dead || !manifest.sets[set]?.slow || switches >= 2) return;
    usingSlow = on; sinceSwitch = 0; fetchEma = 0; switches++;
    try { sessionStorage.setItem("fb-tier", on ? "mid" : "full"); } catch {}
    S = tier(manifest.sets[set]);
    perFrame = S.w * S.h * 4; capacity = capFor();
    // drop the full-size frames; the canvas keeps its current picture until the new tier paints
    for (const [i, f] of frames) release(i, f);
    frames = new Map(); queue = []; gen++; drawn = ""; centre = -999;
    size(); refill(true);
  }

  function useSet(name) {
    const next = tier(manifest.sets[name]);
    const sameMedia = S && next.dir === S.dir;
    set = name; S = next;
    ({ o: order, shot: shotOf, scene: sceneOf } = expand(S));
    posOf = [];                           // frame -> its story positions
    order.forEach((i, p) => (posOf[i] ??= []).push(p));
    sceneEnds = [];                       // scene -> [first, last] position
    sceneOf.forEach((sc, p) => { sceneEnds[sc] ??= [p, p]; sceneEnds[sc][1] = p; });
    perFrame = S.w * S.h * 4;
    capacity = capFor();
    // a quarter of the capacity is reserved for anchors: the first position of every shot,
    // then evenly spaced positions (deduped by frame)
    nAnchors = Math.max(2, Math.floor(capacity / 4));
    const cand = shotOf.flatMap((s, p) => (p === 0 || shotOf[p - 1] !== s ? [p] : []));
    for (let k = 0; k < nAnchors; k++) cand.push(Math.round((k * (order.length - 1)) / (nAnchors - 1)));
    const seen = new Set();
    anchorPos = cand.filter((p) => !seen.has(order[p]) && seen.add(order[p]));
    anchorSet = new Set(anchorPos.map((p) => order[p]));
    if (!sameMedia) {
      // different files: drop everything; the old canvas content stays until a new frame draws
      for (const [i, f] of frames) release(i, f);
      frames = new Map(); queue = []; gen++;
      drawnFrame = -1; shown = -1;
      stage.classList.remove("is-live");    // poster shows again until a new frame is drawn
    }
    drawn = ""; centre = -999; size();
  }

  const posAt = (u) => Math.max(0, Math.min(order.length - 1, Math.round(u)));
  const frameAt = (pos) => order[posAt(pos)];
  const key = (i) => `${S.dir}|${i}`;

  function release(i, f) {
    clearTimeout(f.stallTimer);
    clearTimeout(retryAt.get(i)); retryAt.delete(i);
    if (f.state === "loading") { active--; f.ctl.abort(); note({ i, out: "cancelled", afterFetch: !!f.fetched, ms: performance.now() - f.started }); }
    else if (!f.used) wasted++;
    queuedAt.delete(i);
    f.img?.close();
    f.img = null;
  }

  function admit() {
    // fill free slots from the queue, never exceeding capacity (loading entries count)
    // one slot beyond MAX_ACTIVE is reserved for the requested frame itself, so it never
    // waits behind speculative requests
    const urgent = order && order[posAt(want)];
    while (queue.length && (active < MAX_ACTIVE || (active < MAX_ACTIVE + 1 && queue[0] === urgent)) && frames.size < capacity + 1) {
      const i = queue.shift();
      if (frames.has(i) || !desired.has(i) || retryAt.has(i)) continue;
      if ((fails.get(key(i)) || 0) >= MAX_TRIES) continue;
      load(i);
    }
  }

  function load(i) {
    if ((fails.get(key(i)) || 0) >= MAX_TRIES || frames.has(i)) return;   // loader-side guard
    const g = gen;
    // fetch + createImageBitmap: decoded once, off the main thread, and kept decoded until
    // evicted (an <img> drawn to the canvas was re-decoded on the main thread at every draw)
    const f = { img: null, ctl: new AbortController(), state: "loading", started: performance.now(), stallTimer: 0, fetched: 0, bytes: 0, used: false };
    frames.set(i, f); active++;
    const done = (bmp) => {
      if (g !== gen || frames.get(i) !== f || f.state !== "loading") { bmp?.close(); return; }   // superseded
      clearTimeout(f.stallTimer); active--;
      if (bmp) {
        if (!desired.has(i) && i !== order[posAt(want)]) {
          // finished after the story moved on: keep it only if there is room; then re-plan, so
          // a frame the story comes back to is requested again (it was otherwise lost until the
          // next scroll)
          let ready = 0; for (const e of frames.values()) if (e.state === "ready") ready++;
          if (ready >= capacity) { frames.delete(i); bmp.close(); wasted++; note({ i, out: "late" }); refill(true); return; }
        }
        f.img = bmp; f.state = "ready";
        const now = performance.now();
        note({ i, out: "ok", wait: f.started - (queuedAt.get(i) ?? f.started), fetch: f.fetched - f.started, decode: now - f.fetched, bytes: f.bytes });
        // connection speed: only real downloads count (a frame from the browser cache arrives in
        // a few ms and would make a slow connection look fast)
        const rt = performance.getEntriesByName(new URL(f.url, location.href).href).pop();
        if (!rt || rt.transferSize > 0) fetchEma = fetchEma ? fetchEma * 0.8 + 0.2 * (f.fetched - f.started) : f.fetched - f.started;
        sinceSwitch++;
        if (!slowNet && fetchEma > SLOW_FETCH) { slowNet = true; pvPump(); }
        else slowNet = fetchEma > SLOW_FETCH;
        if (!usingSlow && fetchEma > SLOW_TIER && sinceSwitch >= 4) setTimeout(() => useSlow(true), 0);
        else if (usingSlow && fetchEma < FAST_TIER && sinceSwitch >= 20) setTimeout(() => useSlow(false), 0);
        queuedAt.delete(i);
        notePeak();
        schedule();                       // draw() decides, from the *current* position, whether it is usable
      } else {
        frames.delete(i); f.ctl.abort();
        const n = (fails.get(key(i)) || 0) + 1; fails.set(key(i), n);
        if (n >= MAX_TRIES) {
          if (++exhausted >= FAIL_LIMIT) return fail(`${exhausted} frames failed`);
        } else {
          // bounded retry: only while still wanted, same media, same entry slot empty
          retryAt.set(i, setTimeout(() => {
            retryAt.delete(i);
            if (g === gen && desired.has(i) && !frames.has(i)) { queue.unshift(i); admit(); }
          }, 500 * n));
        }
      }
      admit();
    };
    f.stallTimer = setTimeout(() => done(null), STALL_MS);
    // the requested frame goes ahead of everything else on a shared, slow connection
    const urgent = order && i === order[posAt(want)];
    f.url = `${S.dir}/${pad(i)}.webp`;
    fetch(f.url, { signal: f.ctl.signal, priority: urgent ? "high" : "low" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
      .then((b) => { f.fetched = performance.now(); f.bytes = b.size; return createImageBitmap(b); })
      .then(done, () => done(null));
  }

  // Desired set, built in priority order along the story (not along file numbers), never above
  // capacity and never evicting what it already chose:
  //   1. the requested position's frame, and the frame on screen (so it can be repainted)
  //   2. NEAR positions either side
  //   3. the first positions of the next scene in the direction of travel (0 -> 75 at 169/170)
  //   4. the rest of the window, two ahead for every one behind, up to capacity - anchors
  //   5. anchors, nearest first, in the remaining slots
  // Before warm-up only 1-2 are loaded.
  // 1 = every position; n = every nth while the story moves faster than MAX_ACTIVE requests can
  // fetch it (speed x smoothed download time), capped at FULL_NEAR so a sharp frame is always in reach
  const stride = () => {
    const v = Math.abs(speed());
    if (v < FAST || params.has("nostride")) return 1;
    // whichever is coarser: what the requests can keep up with, or what the screen can show
    // (at 180 positions/s a 60 Hz display shows only every third position anyway)
    const net = (v * (fetchEma || 50)) / 1000 / MAX_ACTIVE, screen = v / 60;
    return Math.max(1, Math.min(FULL_NEAR, Math.round(Math.max(net, screen))));
  };
  let centre = -999, pdir = 1, turnAt = null, lastRegime = false, lastStride = 1;
  function refill(force) {
    const T = posAt(want), L = order.length;
    // direction for prefetching only flips after 3 positions of travel the other way, so small
    // wobbles do not cancel the requests already under way
    if (dir !== pdir && turnAt !== null && Math.abs(T - turnAt) >= 3) { pdir = dir; turnAt = null; force = true; }
    const regime = Math.abs(speed()) >= FAST;
    // re-plan when the story moved, the speed regime changed, or the requested frame is
    // neither loaded nor planned
    if (!force && Math.abs(T - centre) < 2 && regime === lastRegime && stride() === lastStride && (frames.has(order[T]) || desired.has(order[T]))) return;
    centre = T; lastRegime = regime; lastStride = stride();
    pvWant(T);
    const next = new Set(), pri = [];
    const add = (p, cap = capacity) => {
      if (p < 0 || p >= L || next.size >= cap) return;
      const i = order[p];
      if (!next.has(i)) { next.add(i); pri.push(i); }
    };
    add(T);
    if (shown >= 0) add(shown);
    // bandwidth to the storyboard, then to the preview pack under the current position
    const pvHere = !PV || pvFailed || pvPackLoaded(order[T]);
    if (PV && !pvFailed && (!pvPacks[0] || (needPreview() && !pvHere && warm))) { commit(next, pri, T); return; }
    // scrolling faster than frames arrive: fetch every 2nd or 3rd position (fixed parity, so the
    // plan does not churn as T moves). choose() takes a sharp frame within FULL_NEAR positions over
    // a preview, so the picture stays sharp and the same bytes cover two or three times the travel.
    const st = stride();
    const addS = (p, cap) => { if (st === 1 || p % st === 0) add(p, cap); };
    // moving fast: also request where the story will be when the file arrives (~0.2 s ahead)
    const lead = Math.min(40, Math.round(Math.abs(speed()) * 0.2));
    if (lead > NEAR) for (let k = 0; k <= NEAR * st; k++) addS(T + pdir * (lead + k));
    for (let k = 1; k <= NEAR * st; k++) { addS(T + pdir * k); addS(T - pdir * k); }
    // previews carry the story while it moves fast; otherwise the full window follows
    // the full window keeps filling while scrolling unless the connection is too slow for it
    // (then previews carry fast motion and the window fills when scrolling slows)
    if (warm && (Math.abs(speed()) < FAST || !needPreview())) {
      const nA = PV && !pvFailed ? 0 : nAnchors;   // previews replace anchors as the fallback
      const wcap = capacity - nA;
      const sc = sceneOf[T];
      const entry = pdir > 0 ? sceneEnds[sc][1] + 1 : sceneEnds[sc][0] - 1;
      add(entry, wcap); add(entry + pdir, wcap);
      for (let a = NEAR + 1, b = NEAR + 1; next.size < wcap && (a < L || b < L);) {
        addS(T + pdir * a++, wcap);
        if (a % 2) addS(T - pdir * b++, wcap);
      }
      if (nA) for (const p of anchorPos.slice().sort((x, y) => Math.abs(x - T) - Math.abs(y - T))) add(p);
    }
    commit(next, pri, T);
  }
  function commit(next, pri, T) {
    desired = next;
    const now = performance.now();
    for (const i of pri) if (!frames.has(i) && !queuedAt.has(i)) queuedAt.set(i, now);
    // a request already under way is finished rather than thrown away if it is still close to
    // where the story is (cancel-and-refetch was half of all requests on a phone connection)
    const near = (i) => posOf[i]?.some((q) => Math.abs(q - T) <= KEEP);
    for (const [i, f] of frames) if (!desired.has(i) && !(f.state === "loading" && near(i))) { release(i, f); frames.delete(i); }
    for (const [i, t] of retryAt) if (!desired.has(i)) { clearTimeout(t); retryAt.delete(i); }
    queue = pri.filter((i) => !frames.has(i));
    admit();
  }

  // ------------------------------------------------------------------ preview tier
  // manifest.preview: every frame at 512x288, packed into a few files in story order. Packs
  // load one at a time, the one under the current position first; previews around the
  // target are decoded into a small bitmap cache and drawn only while the full-size frame for
  // the requested position is not ready, so the story keeps moving on a slow connection. If
  // the packs fail, the player falls back to full-size anchors as before.
  const PV = manifest.preview?.packs?.length ? manifest.preview : null;
  const PV_MAX = phone ? PV_CAP.phone : PV_CAP.desktop;
  const pvPacks = [];                     // pack index -> Blob
  const pvBmp = new Map();                // frame -> ImageBitmap (insertion order = LRU)
  const pvBusy = new Set();               // frames being decoded
  const pvAt = [];                        // pack arrival times (QA)
  const pvCtl = new AbortController();
  let pvFetching = false, pvFailed = false, pvTries = 0;
  const pvWhere = new Map();              // frame -> [pack, index in pack]
  PV?.packs.forEach((k, n) => k.frames.forEach((i, j) => pvWhere.set(i, [n, j])));
  const pvPackOf = (i) => pvWhere.get(i)?.[0] ?? -1;
  const pvPackLoaded = (i) => !!pvPacks[pvPackOf(i)];
  function pvPump() {
    if (!PV || pvFetching || pvFailed || dead || !order) return;
    // pack 0 (storyboard) first; then the pack under the requested position, then onwards in
    // the direction of travel (packs after 0 are in story order)
    const here = pvPackOf(order[posAt(want)]);
    const ks = PV.packs.map((_, k) => k).slice(1);
    const onward = pdir > 0 ? ks.filter((k) => k > here) : ks.filter((k) => k < here).reverse();
    const back = pdir > 0 ? ks.filter((k) => k < here).reverse() : ks.filter((k) => k > here);
    // only the storyboard before warm-up (first scroll or idle), like the full-size window
    // the fine packs only when full frames are measurably slow (on a fast connection they would
    // just compete with the sharp frames)
    const k = (warm && needPreview() ? [0, here, ...onward, ...back] : [0]).find((c) => c >= 0 && !pvPacks[c]);
    if (k === undefined) return;
    pvFetching = true;
    fetch(PV.packs[k].url, { signal: pvCtl.signal, priority: k ? "low" : "high" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
      .then((b) => { pvPacks[k] = b; pvAt[k] = Math.round(performance.now()); pvFetching = false; pvWant(posAt(want)); refill(true); pvPump(); },
            () => { pvFetching = false; if (dead) return; if (++pvTries >= 3) { pvFailed = true; refill(true); } else setTimeout(pvPump, 800 * pvTries); });
  }
  function pvWant(T) {
    if (!PV || dead) return;
    pvPump();
    // decode previews for the positions just ahead, and behind as far as a stand-in may be
    // (after a jump the nearest storyboard frame can be up to MAX_SUB positions back)
    for (let d = 0, n = 0; d <= 14 && pvBusy.size < 2; d++) {
      for (const p of d && d <= MAX_SUB ? [T + pdir * d, T - pdir * d] : [T + pdir * d]) {
        if (p < 0 || p >= order.length || isFull(p)) continue;
        const i = order[p];
        if (pvBmp.has(i)) { const b = pvBmp.get(i); pvBmp.delete(i); pvBmp.set(i, b); continue; }   // refresh LRU
        if (pvBusy.has(i) || pvBusy.size >= 2) continue;
        const [k, j] = pvWhere.get(i) || [];
        const pack = pvPacks[k];
        if (!pack) continue;
        const o = PV.packs[k].offs;
        pvBusy.add(i); n++;
        createImageBitmap(pack.slice(o[j], o[j + 1], "image/webp")).then((b) => {
          pvBusy.delete(i);
          if (dead) return b.close();
          pvBmp.set(i, b);
          while (pvBmp.size > PV_MAX) { const [old, ob] = pvBmp.entries().next().value; pvBmp.delete(old); ob.close(); }
          schedule(); pvWant(posAt(want));
        }, () => pvBusy.delete(i));
      }
    }
  }

  // ------------------------------------------------------------------ drawing
  const schedule = () => { if (!raf && !dead) raf = requestAnimationFrame(draw); };
  // fit: cover (default) | height (landscape phones: whole frame, pushed right so the burger
  // clears the hero copy) | camera (portrait: the canvas is the food band under the nav, and
  // manifest.camera[frame] = [cx, cy, w, h] is the box, in fractions of the frame, that fills it;
  // the poster uses the same formula in CSS, so the first frame lands exactly on it)
  const CAM = manifest.camera;
  const camScale = (i, cw, ch) => { const [, , bw, bh] = CAM[i]; return Math.min(cw / (bw * S.w), ch / (bh * S.h)); };
  const scaleFor = (cw, ch, i) => (S.fit === "camera" && CAM ? camScale(i ?? 0, cw, ch)
    : S.fit === "height" ? (ch / S.h) * (S.zoom || 1) : Math.max(cw / S.w, ch / S.h));
  // backing store no denser than the source can fill (no 2880 px canvas from a 1600 px frame);
  // with the camera, sized for the closest framing in the story so it never changes mid-scroll
  function size() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !S) return;
    const smax = S.fit === "camera" && CAM ? Math.max(...CAM.map((_, i) => camScale(i, cw, ch))) : scaleFor(cw, ch);
    const density = Math.min(devicePixelRatio || 1, Math.max(0.75, 1 / smax));
    const w = Math.round(cw * density), h = Math.round(ch * density);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; drawn = ""; }
  }
  // Which story position to show for requested position T. Only frames that belong there:
  //   - T's own frame;
  //   - else the ready position closest to T on the path from what is on screen to T (catching
  //     up through what the user scrolled past, in story order; the screen itself counts);
  //   - unless a ready position in T's scene, within MAX_SUB positions, is closer still;
  //   - else keep whatever is on screen (or the poster) until a usable frame arrives.
  // Never a frame chosen for its file number: 313 (closed box) is not "near" 74.
  const isFull = (p) => frames.get(order[p])?.state === "ready";
  const isReady = (p) => isFull(p) || pvBmp.has(order[p]);
  function choose(T) {
    if (isFull(T)) return T;
    // a sharp frame a step or two away reads better than a soft preview of the exact one, and
    // avoids sharp -> soft -> sharp flicker while scrolling
    // (how near scales with speed: ~80 ms of travel, i.e. imperceptible lag, capped at MAX_SUB)
    const nearLim = Math.min(MAX_SUB, Math.max(FULL_NEAR, Math.round(Math.abs(speed()) * 0.08)));
    for (let d = 1; d <= nearLim; d++) {
      for (const p of [T - d * Math.sign(T - shown || 1), T + d * Math.sign(T - shown || 1)]) {
        if (p >= 0 && p < order.length && sceneOf[p] === sceneOf[T] && isFull(p)) return p;
      }
    }
    if (isReady(T)) return T;
    let best = -1;
    if (shown >= 0 && shown !== T) {
      const s = Math.sign(shown - T);
      for (let p = T + s; p !== shown + s; p += s) if (isReady(p)) { best = p; break; }
    }
    for (let d = 1; d <= MAX_SUB && (best < 0 || d < Math.abs(best - T)); d++) {
      for (const p of [T - d, T + d]) if (p >= 0 && p < order.length && sceneOf[p] === sceneOf[T] && isReady(p)) return p;
    }
    return best >= 0 ? best : shown;
  }
  function draw() {
    raf = 0;
    if (dead || !S) return;
    const T = posAt(want);
    const p = choose(T);
    // starving: nothing usable near the requested position (the watchdog degrades after STARVE_MS)
    if (p < 0 || Math.abs(p - T) > MAX_SUB) { if (!starveSince) starveSince = performance.now(); } else starveSince = 0;
    if (p < 0) return;
    shown = p;
    // captions follow what is on screen, not the scroll position
    copy.seek(((p === T ? Math.max(0, Math.min(order.length - 1, want)) : p) / (order.length - 1)) * UNITS);
    if (!isReady(p)) return;              // kept position whose frame was evicted: leave the canvas as is
    const i = order[p];
    const full = isFull(p);
    const k = `${set}|${i}|${full ? "f" : "p"}|${canvas.width}x${canvas.height}`;
    if (k === drawn) return;
    const img = full ? frames.get(i).img : pvBmp.get(i);
    const cw = canvas.width, ch = canvas.height, s = scaleFor(cw, ch, i);
    const w = S.w * s, h = S.h * s;
    const [fx, fy] = S.fit === "camera" && CAM ? CAM[i] : S.focus || [0.5, 0.5];
    const x = w >= cw ? Math.min(0, Math.max(cw - w, cw / 2 - w * fx)) : Math.round((cw - w) * fx);
    const y = S.fit === "camera" && CAM ? ch / 2 - h * fy
      : h >= ch ? Math.min(0, Math.max(ch - h, ch / 2 - h * fy)) : Math.round((ch - h) * fy);
    if (w < cw) {
      // pillarboxed (landscape phones): charcoal fill, frame, feather its left and right edges
      ctx.fillStyle = INK; ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, x, y, w, h);
      const f = w * 0.12;
      for (const [x0, x1] of [[x, x + f], [x + w, x + w - f]]) {
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, INK); g.addColorStop(1, "rgba(18,15,14,0)");
        ctx.fillStyle = g; ctx.fillRect(Math.min(x0, x1) - 1, 0, f + 2, ch);
      }
    } else if (h < ch || y > 0 || y + h < ch) {
      // letterboxed (phones): charcoal fill, frame, then feather its top and bottom edges
      ctx.fillStyle = INK; ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, x, y, w, h);
      const f = h * 0.16;
      for (const [y0, y1] of [[y, y + f], [y + h, y + h - f]]) {
        const g = ctx.createLinearGradient(0, y0, 0, y1);
        g.addColorStop(0, INK); g.addColorStop(1, "rgba(18,15,14,0)");
        ctx.fillStyle = g; ctx.fillRect(0, Math.min(y0, y1) - 1, cw, f + 2);
      }
    } else {
      ctx.drawImage(img, x, y, w, h);
    }
    drawn = k; drawnFrame = i; paints++;
    if (full) frames.get(i).used = true; else pvPaints++;
    canvas.dataset.frame = i; canvas.dataset.q = full ? (usingSlow ? "mid" : "full") : "preview";
    if (!stage.classList.contains("is-live")) { stage.classList.add("is-live"); onFirstPaint(); }
  }
  let paints = 0, pvPaints = 0;

  function notePeak() {
    let r = 0; for (const f of frames.values()) if (f.state === "ready") r++;
    if (r > peak.retained) peak = { retained: r, mb: +(r * perFrame / 1048576).toFixed(1), at: frameAt(want) };
  }

  // Anchors and the full window are not needed for the first screen. They start on the first
  // scroll, or a few seconds after the page has loaded and the browser is idle, so they never
  // compete with the poster, fonts and copy.
  let warmSoon = false;
  const warmUp = () => { if (!warm && !dead) { warm = true; refill(true); } };
  function onFirstPaint() {
    const later = () => setTimeout(() => ("requestIdleCallback" in window ? requestIdleCallback(warmUp, { timeout: 2000 }) : warmUp()), 3000);
    if (document.readyState === "complete") later(); else addEventListener("load", later, { once: true });
  }

  // starvation watchdog: the wanted position has had nothing drawable for too long
  const watchdog = setInterval(() => {
    if (starveSince && performance.now() - starveSince > STARVE_MS) fail("no frame could be shown");
    else if (!starveSince && drawnFrame < 0 && performance.now() - startedAt > STARVE_MS) fail("first frame never arrived");
  }, 1000);
  const startedAt = performance.now();

  // ------------------------------------------------------------------ timeline
  const state = { u: 0 };
  let dir = 1, lastU = 0;
  const bar = document.querySelector("[data-progress]");
  const shade = stage.querySelector(".stage__shade");
  const beat = (n) => stage.querySelector(`[data-beat="${n}"]`);
  // scrub: true links the story directly to the scroll position. A numeric scrub adds playhead
  // catch-up: 0.12 s measured 80-100 ms extra settle on desktop, 0.06 s ~45 ms. The page's own
  // smooth scrolling (wheel, touch momentum) still provides the smoothing.
  const scrub = params.has("scrub") ? (params.get("scrub") === "true" ? true : Number(params.get("scrub"))) : true;

  const tl = gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: { trigger: "#story", start: "top top", end: "bottom bottom", scrub, invalidateOnRefresh: true },
  });
  const st = tl.scrollTrigger;
  let keep = null;
  const onResizeEarly = () => {
    if (keep !== null) return;
    const p = (scrollY - st.start) / (st.end - st.start);
    if (p > 0 && p < 1) keep = p;
  };
  addEventListener("resize", onResizeEarly);
  // a refresh (load with a restored scroll position, layout change) must not sweep the story
  // through every scene between the old and the new position: finish the scrub at once
  const snap = () => { const t = st.getTween?.(); if (t && typeof t.progress === "function") t.progress(1); };
  const onRefresh = () => {
    snap();
    if (keep === null) return;
    const p = keep; keep = null;
    requestAnimationFrame(() => { st.scroll(st.start + p * (st.end - st.start)); ScrollTrigger.update(); snap(); });
  };
  ScrollTrigger.addEventListener("refresh", onRefresh);

  tl.to(state, {
    u: UNITS, duration: UNITS,
    onUpdate() {
      if (state.u !== lastU) { dir = state.u > lastU ? 1 : -1; lastU = state.u; }
      if (!order) return;                 // media not chosen yet (waiting for the poster)
      want = (state.u / UNITS) * (order.length - 1);
      const now = performance.now(), dt = (now - velT) / 1000;
      if (dt > 0.008) { vel = vel * 0.6 + 0.4 * ((want - velPos) / Math.min(dt, 0.25)); velT = now; velPos = want; }
      if (dir !== pdir && turnAt === null) turnAt = posAt(want);
      if (dir === pdir) turnAt = null;
      // first scroll: let its first frames go out before the warm-up's requests and decodes
      if (!warm && !warmSoon && state.u > 0.2) { warmSoon = true; setTimeout(warmUp, 120); }
      refill(false);
      draw();
    },
  }, 0);
  tl.to(bar, { scaleX: 1, duration: UNITS }, 0);
  // captions and shade live on their own paused timeline, seeked by draw() to the position that
  // is actually on screen, so copy never runs ahead of (or behind) the picture
  const copy = gsap.timeline({ paused: true, defaults: { ease: "none" } });
  const show = (el, at, len = 8) =>
    copy.fromTo(el, { autoAlpha: 0, y: 26 }, { autoAlpha: 1, y: 0, duration: len, ease: "power2.out" }, at);
  const hide = (el, at, len = 8) =>
    copy.to(el, { autoAlpha: 0, y: -26, duration: len, ease: "power2.in" }, at);
  const B = { heroOut: 9, layersIn: 34, layersOut: 88, stackIn: 64, stackOut: 80, mealIn: 128, mealOut: 176, closeIn: 200, ...(manifest.beats || {}) };
  hide(beat("hero"), B.heroOut, 10);
  copy.to(shade, { opacity: 0.45, duration: 20 }, B.heroOut + 1);
  show(beat("layers"), B.layersIn); hide(beat("layers"), B.layersOut);
  show(beat("stack"), B.stackIn); hide(beat("stack"), B.stackOut);
  show(beat("meal"), B.mealIn); hide(beat("meal"), B.mealOut);
  show(beat("close"), B.closeIn, 10);
  copy.to(shade, { opacity: 0.2, duration: 10 }, B.closeIn - 4);
  copy.to({}, { duration: UNITS }, 0);      // full length, so seeking to the end is exact

  // ------------------------------------------------------------------ start
  // the first frame request waits for the poster (the LCP image), so frames never compete with it
  const poster = stage.querySelector(".stage__poster");
  if (poster && !poster.complete) await new Promise((r) => {
    poster.addEventListener("load", r, { once: true }); poster.addEventListener("error", r, { once: true }); setTimeout(r, 3000);
  });
  if (dead) return teardown;
  useSet(pick());
  ScrollTrigger.update(); snap();         // reload mid-story: start where the page is, not at the top
  want = (state.u / UNITS) * (order.length - 1);
  refill(true); schedule();

  let rt, lastBox = "";
  const onResize = () => {
    // browser bars on phones fire resize without changing the band or the frame set: skip
    const box = `${canvas.clientWidth}x${canvas.clientHeight}|${pick()}`;
    if (box === lastBox) return;
    lastBox = box;
    size(); schedule();
    clearTimeout(rt);
    rt = setTimeout(() => {
      const next = pick();
      if (next !== set) { useSet(next); refill(true); }
      size(); drawn = ""; schedule();
    }, 150);
  };
  addEventListener("resize", onResize);

  function teardown() {
    clearInterval(watchdog); clearTimeout(rt);
    removeEventListener("resize", onResize); removeEventListener("resize", onResizeEarly);
    ScrollTrigger.removeEventListener("refresh", onRefresh);
    for (const [i, f] of frames) release(i, f);
    frames.clear(); queue = []; desired = new Set();
    for (const b of pvBmp.values()) b.close(); pvBmp.clear(); pvCtl.abort();
    st?.kill(); tl.kill(); copy.kill(); gsap.set([stage.querySelectorAll("[data-beat]"), shade, bar], { clearProps: "all" });
  }

  // read-only snapshot for QA scripts. "estRetainedDecodedMB" = ready frames x w x h x 4; it is
  // an estimate of decoded image data held by this player, not total browser memory.
  // "pos"/"shown" are story positions, "target"/"drawnFrame" the matching source frames.
  const SHOTS = manifest.shots || [];
  const shotName = (p) => (p < 0 ? "poster" : SHOTS[shotOf[p]] || `shot${shotOf[p]}`);
  window.__storyStats = () => {
    const q = (a, p) => { const x = a.filter((v) => v >= 0).sort((m, n) => m - n); return x.length ? Math.round(x[Math.min(x.length - 1, Math.floor(p * x.length))]) : null; };
    const ok = trace.filter((r) => r.out === "ok"), can = trace.filter((r) => r.out === "cancelled");
    return { ok: ok.length, cancelled: can.length, cancelledAfterFetch: can.filter((r) => r.afterFetch).length, wastedDecoded: wasted,
             waitP50: q(ok.map((r) => r.wait), 0.5), waitP95: q(ok.map((r) => r.wait), 0.95), fetchP50: q(ok.map((r) => r.fetch), 0.5), fetchP95: q(ok.map((r) => r.fetch), 0.95),
             decodeP50: q(ok.map((r) => r.decode), 0.5), decodeP95: q(ok.map((r) => r.decode), 0.95), KB: Math.round(ok.reduce((s, r) => s + r.bytes, 0) / 1024),
             late: trace.filter((r) => r.out === "late").length, previewPacks: pvPacks.filter(Boolean).length, packAt: pvAt, previewDecoded: pvBmp.size, previewPaints: pvPaints, paints };
  };
  window.__story = () => {
    let ready = 0, loading = 0, anchorsReady = 0;
    for (const [i, f] of frames) { f.state === "ready" ? ready++ : loading++; if (f.state === "ready" && anchorSet.has(i)) anchorsReady++; }
    const T = posAt(want);
    return { version: manifest.version, set, dir: S.dir, frameSize: `${S.w}x${S.h}`, want, pos: T, shot: shotName(T), scene: sceneOf[T],
             target: order[T], targetReady: isReady(T), shown, shownShot: shotName(shown), shownScene: shown < 0 ? -1 : sceneOf[shown], drawnFrame,
             scrollDir: dir, prefetchDir: pdir,
             ready, loading, retained: frames.size, capacity, anchors: anchorSet.size, anchorsRetained: anchorsReady,
             anchorBudget: nAnchors, warm, desired: desired.size,
             estRetainedDecodedMB: +((ready * perFrame + pvBmp.size * (PV ? PV.w * PV.h * 4 : 0)) / 1048576).toFixed(1), budgetMB: BUDGET / 1048576,
             quality: canvas.dataset.q, vel: Math.round(vel), fetchEma: Math.round(fetchEma), slowNet, tier: usingSlow ? "mid" : "full",
             peak, exhausted, paints, scrub, canvas: `${canvas.width}x${canvas.height}`, dead };
  };
  return teardown;
}

async function loadManifest() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch("/media/manifest.json", { cache: "no-cache", signal: ctl.signal });
    if (!r.ok) return null;
    const m = await r.json();
    const ok = m && m.sets && Object.values(m.sets).length && Object.values(m.sets).every((s) =>
      typeof s.dir === "string" && s.w > 0 && s.h > 0 && s.count > 0 && Array.isArray(s.timeline) && s.timeline.length &&
      s.timeline.every((t) => Array.isArray(t) && t.every((n) => Number.isInteger(n) && n >= 0 && n < s.count + 1000)) &&
      s.timeline.every((t) => t[0] < s.count && t[1] < s.count));
    return ok ? m : null;
  } catch { return null; } finally { clearTimeout(t); }
}
