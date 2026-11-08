import { MENU, MENU_SOURCE, FEATURED } from "./data/menu.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const rupee = (n) => `₹${n}`;
const dietMark = (d) =>
  d === "veg" || d === "nonveg"
    ? `<span class="diet diet--${d}" role="img" aria-label="${d === "veg" ? "Vegetarian" : "Non-vegetarian"}"></span>`
    : "";

function itemRow(it, diet) {
  const chips = [];
  if (it.sizes) for (const [label, p] of it.sizes) chips.push(`<span class="chip">${esc(label)} <b>${rupee(p)}</b></span>`);
  if (it.pack2) chips.push(`<span class="chip">Pack for 2 <b>${rupee(it.pack2)}</b></span>`);
  if (it.pack3) chips.push(`<span class="chip">Pack for 3 <b>${rupee(it.pack3)}</b></span>`);
  // sized items show their prices as chips, so the headline price would only repeat one of them
  const price = it.sizes || it.price == null ? (it.note === "MRP" ? "MRP" : "") : rupee(it.price);
  const note = it.note && it.note !== "MRP" ? `<p class="item__note">${esc(it.note)}</p>` : "";
  return `<li class="item">
    <span class="item__name">${dietMark(diet)}${esc(it.name)}</span>
    <span class="item__price">${price}${it.meal ? `<small>Meal ${rupee(it.meal)}</small>` : ""}</span>
    ${note}
    ${chips.length ? `<div class="item__alt">${chips.join("")}</div>` : ""}
  </li>`;
}

// Static HTML for the whole menu. Injected into index.html at build/dev time (vite.config.js),
// so the menu is readable without JavaScript; initMenu() only adds tab behaviour on top.
export function menuHTML() {
  const note = `Prices from the <a href="${MENU_SOURCE.url}" target="_blank" rel="noopener">menu the Bistro posted on 4 Oct 2025</a>. Demo menu — prices to confirm at the truck.`;
  const lineup = FEATURED.map((f) => `
    <li>
      <span class="diet-label">${dietMark(f.diet)}${f.diet === "veg" ? "Veg" : "Chicken"}</span>
      <h3>${esc(f.name)}</h3>
      <p>${esc(f.line)}</p>
      <p class="prices"><strong>${rupee(f.price)}</strong><span class="chip chip--meal">Meal <b>${rupee(f.meal)}</b></span></p>
    </li>`).join("");
  const tabs = MENU.map((c, i) => {
    const n = c.groups.reduce((a, g) => a + g.items.length, 0);
    return `<button class="tab" type="button" role="tab" id="tab-${c.id}" aria-controls="panel-${c.id}"
      aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${dietMark(c.diet)}${esc(c.label)}<span class="count">${n}</span></button>`;
  }).join("");
  // without JS every panel shows, each with its own heading; with JS the tabs take over
  const panels = MENU.map((c) => `
    <div class="panel" id="panel-${c.id}">
      <h3 class="panel__title">${esc(c.label)}</h3>
      <ul class="jump" aria-label="${esc(c.label)} sections">
        ${c.groups.map((g) => `<li><a href="#${g.id}">${esc(g.title)}</a></li>`).join("")}
      </ul>
      <div class="groups">
        ${c.groups.map((g) => `
          <section class="group" id="${g.id}" aria-labelledby="${g.id}-h">
            <h3 id="${g.id}-h">${esc(g.title)}</h3>
            <ul class="items">${g.items.map((it) => itemRow(it, g.diet || c.diet)).join("")}</ul>
          </section>`).join("")}
      </div>
    </div>`).join("");
  return { note, lineup, tabs, panels };
}

export function initMenu() {
  const tabs = document.querySelector("[data-tabs]");
  if (!tabs || !tabs.children.length) return;
  tabs.hidden = false;
  document.documentElement.classList.add("menu-tabs");
  for (const p of document.querySelectorAll("[data-panels] .panel")) {
    p.setAttribute("role", "tabpanel"); p.setAttribute("aria-labelledby", p.id.replace("panel-", "tab-")); p.tabIndex = 0;
  }
  const btns = [...tabs.querySelectorAll('[role="tab"]')];
  const select = (b, focus) => {
    for (const x of btns) {
      const on = x === b;
      x.setAttribute("aria-selected", on);
      x.tabIndex = on ? 0 : -1;
      document.getElementById(x.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) b.focus();
  };
  select(btns[0]);
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest('[role="tab"]');
    if (!b) return;
    select(b);
    // keep the tab bar in view when switching from further down the list
    const top = document.getElementById("menu-title").getBoundingClientRect().top;
    if (top < -200) tabs.scrollIntoView({ block: "start" });
  });
  tabs.addEventListener("keydown", (e) => {
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const k = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: btns.length - 1 }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    select(btns[(k + btns.length) % btns.length], true);
  });
}
