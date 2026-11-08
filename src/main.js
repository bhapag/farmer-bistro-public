import { initMenu } from "./menu.js";

const root = document.documentElement;
initMenu();

// Hero headline: wrap each word for the line-mask reveal (styles.css, "editorial reveal")
for (const h of document.querySelectorAll("[data-split]")) {
  h.setAttribute("aria-label", h.textContent);
  h.innerHTML = h.textContent.trim().split(/\s+/).map((w, i) => `<span class="w" aria-hidden="true"><span style="--i:${i}">${w}</span></span>`).join(" ");
  if (root.classList.contains("is-loading")) h.classList.add("is-ready");
}
requestAnimationFrame(() => requestAnimationFrame(() => {
  root.classList.remove("is-loading");
  for (const h of document.querySelectorAll("[data-split]")) h.classList.add("is-in");
}));

const nav = document.querySelector("[data-nav]");
const story = document.getElementById("story");
const skip = document.querySelector("[data-skip]");
const onScroll = () => {
  nav.classList.toggle("is-solid", scrollY > story.offsetHeight - innerHeight * 1.05);
  // past the hero (which has its own "View menu"), offer a way out of the long story
  skip?.classList.toggle("is-on", scrollY > innerHeight * 0.4 && scrollY < story.offsetHeight - innerHeight * 1.2);
};
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Degraded state: drop the scroll runway and show the still images, keeping the reader's
// place relative to the menu. Used when the player can't load, start or keep frames coming.
function goStatic(reason) {
  if (!root.classList.contains("motion")) return;
  const menuTop = document.getElementById("menu").getBoundingClientRect().top;
  const wasPastStory = menuTop < innerHeight;
  root.classList.remove("motion");
  root.dataset.storyFallback = reason;
  if (wasPastStory) document.getElementById("menu").scrollIntoView();
  onScroll();
  console.info("[story] static fallback:", reason);
}

if (root.classList.contains("motion")) {
  const start = import("./story.js").then(({ initStory }) => initStory({ onFail: goStatic }));
  const deadline = setTimeout(() => goStatic("player did not start in time"), 15000);
  start.then(() => clearTimeout(deadline), (e) => { clearTimeout(deadline); goStatic("player failed to load: " + e.message); });
  // presentation mode: ?present
  if (new URLSearchParams(location.search).has("present")) import("./present.js").then(({ initPresent }) => initPresent());
}
