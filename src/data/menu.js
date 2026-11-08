// Transcribed from the pinned Instagram menu carousel, published 4 Oct 2025:
// https://www.instagram.com/the_farmer_bistro_/p/DPZDwYXk805/  (sheets 1–4, saved in research/sources)
// Prices are historical. Every entry is "to-confirm" until the owner checks it.
// price = single item, meal = meal price printed next to it, pack2/pack3 = family pack prices.

export const MENU_SOURCE = {
  url: "https://www.instagram.com/the_farmer_bistro_/p/DPZDwYXk805/",
  published: "2025-10-04",
  label: "The Farmer Bistro menu, Instagram, 4 Oct 2025",
};

const S1 = "sheet-1-veg", S2 = "sheet-2-family", S3 = "sheet-3-nonveg", S4 = "sheet-4-buckets";

const item = (name, price, extra = {}) => ({
  name, price, status: "to-confirm", published: MENU_SOURCE.published, ...extra,
});

export const MENU = [
  {
    id: "veg", label: "Veg", diet: "veg",
    groups: [
      { id: "veg-burgers", title: "Burgers", source: S1, items: [
        item("Aloo Tikki", 48, { meal: 137 }),
        item("Potato Krisper", 90, { meal: 179 }),
        item("Chaap Burger", 75, { meal: 168 }),
        item("Crispy Veg", 100, { meal: 200 }),
        item("Cheesy Crunch", 126, { meal: 210 }),
        item("Spicy Paneer", 147, { meal: 231 }),
      ]},
      { id: "veg-wraps", title: "Wraps", source: S1, items: [
        item("Aloo Wrap", 85, { meal: 179 }),
        item("Chaap Wrap", 116, { meal: 200 }),
        item("Crispy Veg Burrito", 137, { meal: 215 }),
        item("Paneer Wrap", 168, { meal: 263 }),
      ]},
      { id: "veg-sandwich", title: "Sandwiches", source: S1, items: [
        item("Zesty Sandwich", 116),
        item("Tandoori Cheesy Sandwich", 130),
        item("Paneer Sandwich", 180),
      ]},
      { id: "veg-snacks", title: "Snacks & fries", source: S1, items: [
        item("French Fries", 85),
        item("Peri Peri Fries", 100),
        item("Lemon Chilli Fries", 110),
        item("Cheesy Fries", 126),
        item("Veg Strips", 138, { note: "6 pc" }),
        item("Onion Rings", 138, { note: "6 pc" }),
        item("Cheese Corn Roll", 147, { note: "5 pc" }),
      ]},
      { id: "veg-biryani", title: "Biryani bowls", source: S1, items: [
        item("Veg Biryani Bowl", 130),
        item("Chaap Biryani Bowl", 137),
        item("Paneer Biryani", 168),
      ]},
      { id: "veg-drinks", title: "Drinks & shakes", source: S1, items: [
        item("Mint Mojito", 85),
        item("Cold Coffee", 110),
        item("Strawberry Shake", 110),
        item("Chocolate Shake", 110),
        item("Cold drinks", null, { note: "MRP" }),
      ]},
      { id: "veg-addon", title: "Add-on", source: S1, items: [
        item("Cheese slice & dip sauce", 20, { note: "with any burger or wrap" }),
      ]},
    ],
  },
  {
    id: "nonveg", label: "Non-veg", diet: "nonveg",
    groups: [
      { id: "nv-burgers", title: "Burgers", source: S3, items: [
        item("Egg Burger", 70, { meal: 170 }),
        item("Rockin", 116, { meal: 200 }),
        item("Reg. Chicken Zinger", 138, { meal: 220 }),
        item("Tandoori Zinger", 160, { meal: 240 }),
        item("Deluxe", 175, { meal: 265 }),
        item("Double Crunch", 180),
        item("Farmer Zinger", 200, { meal: 295 }),
      ]},
      { id: "nv-wraps", title: "Wraps", source: S3, items: [
        item("Double Egg Wrap", 110, { meal: 190 }),
        item("Zesty Wrap", 130, { meal: 210 }),
        item("Tandoori Wrap", 160, { meal: 240 }),
        item("Mexican Burrito", 170, { meal: 250 }),
        item("Spicy Chicken Wrap", 180, { meal: 270 }),
      ]},
      { id: "nv-snacks", title: "Snacks & bowls", source: S3, items: [
        item("Chicken Popcorn", 170, { sizes: [["Medium", 170], ["Large", 230]] }),
        item("Popcorn Biryani Bowl", 148, { sizes: [["Medium", 148], ["Large", 190]] }),
        item("Chest Biryani Bowl", 180, { sizes: [["Medium", 180], ["Large", 210]] }),
      ]},
      { id: "nv-legs", title: "Leg bucket", source: S3, items: [
        item("Chicken leg, 2 pc + 1 dip", 160),
        item("Chicken leg, 4 pc + 1 dip", 300),
        item("Chicken leg, 6 pc + 1 dip", 435),
      ]},
      { id: "nv-strips-wings", title: "Strips & wings", source: S4, items: [
        item("Boneless Strips", 160, { sizes: [["4 pc", 160], ["6 pc", 240], ["15 pc", 550]] }),
        item("Chicken Hot Wings", 150, { sizes: [["4 pc", 150], ["8 pc", 280], ["12 pc", 410]] }),
      ]},
      { id: "nv-buckets", title: "Big buckets", source: S4, items: [
        item("Boneless Bucket", 280, { note: "2 pc boneless chest, 2 strips, 1 dip, 1 Coke" }),
        item("8 pc Bucket", 450, { note: "8 hot & crispy combination" }),
        item("Big 12 Bucket", 560, { note: "4 pc leg, 6 hot wings, 2 strips, 2 dips, 2 Coke" }),
        item("Signature Farmer Bucket", 590, { note: "4 pc leg, 4 hot wings, 4 strips, 3 dips, 3 Coke" }),
      ]},
    ],
  },
  {
    id: "family", label: "Family packs", diet: "mixed",
    groups: [
      { id: "fam-veg", title: "Veg packs", source: S2, diet: "veg", items: [
        item("Aloo Tikki", null, { pack2: 280, pack3: 360 }),
        item("Crispy Veg", null, { pack2: 380, pack3: 520 }),
        item("Spicy Paneer", null, { pack2: 480, pack3: 670 }),
      ]},
      { id: "fam-nonveg", title: "Non-veg packs", source: S2, diet: "nonveg", items: [
        item("Chicken Rockin", null, { pack2: 380, pack3: 530 }),
        item("Reg. Chicken Zinger", null, { pack2: 440, pack3: 620 }),
        item("Tandoori Chicken Zinger", null, { pack2: 480, pack3: 680 }),
      ]},
    ],
  },
];

// Three burgers pulled forward as the opening "line-up" of the menu section.
export const FEATURED = [
  { name: "Farmer Zinger", diet: "nonveg", price: 200, meal: 295, line: "The burger that carries the truck's name." },
  { name: "Tandoori Zinger", diet: "nonveg", price: 160, meal: 240, line: "Crispy chicken with a tandoori kick." },
  { name: "Spicy Paneer", diet: "veg", price: 147, meal: 231, line: "The priciest veg burger on the board." },
];
