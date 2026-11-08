import { defineConfig } from "vite";
import { menuHTML } from "./src/menu.js";

// Render the verified menu into index.html (dev and build), so it is real HTML without JS.
const staticMenu = {
  name: "static-menu",
  transformIndexHtml(html) {
    const m = menuHTML();
    return html.replace("<!--menu:note-->", m.note).replace("<!--menu:lineup-->", m.lineup)
      .replace("<!--menu:tabs-->", m.tabs).replace("<!--menu:panels-->", m.panels);
  },
};

export default defineConfig({ plugins: [staticMenu] });
