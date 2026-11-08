# The Farmer Bistro: scroll-story website demo

A concept website for The Farmer Bistro, a food truck in Ludhiana. It uses Vite
and GSAP: a scroll-scrubbed canvas story of a burger coming apart and being
boxed, drawn from pre-rendered frames with tiered delivery for desktop and phone.

**This is a design demonstration, not the business's official site.** It is
published with the owner's approval so others can read and learn from it. It
takes no orders, payments or bookings. Menu items and prices come from a post
dated 4 October 2025 and may be out of date.

The burger, fries, chicken strips, cola and packaging in the scroll story are
AI-generated demo artwork, not photographs of the Bistro's food.

## Run

```bash
npm install
npm run dev       # http://localhost:5288
npm run build     # static output in dist/
npm run preview   # http://localhost:5289
```

## Where things live

| What | Where |
|---|---|
| Page and copy | `index.html` |
| Scroll engine (frame loading, tiers, canvas) | `src/story.js` |
| Menu data and rendering | `src/data/menu.js`, `src/menu.js` |
| Styles | `src/styles.css` |
| Frames and manifest | `public/media/` |

The Blender scene, source footage and frame-encoding scripts are not part of
this release.

## Licence

The original code is [MIT](LICENSE). See [NOTICE.md](NOTICE.md): The Farmer
Bistro's name, logo, photographs and menu, and the artwork that shows the logo,
are **not** covered by the MIT licence.
