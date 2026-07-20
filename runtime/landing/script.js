const header = document.querySelector(".site-header");
const toggle = document.querySelector(".menu-toggle");
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const yearEl = document.getElementById("year");
if (yearEl) {
  yearEl.textContent = String(new Date().getFullYear());
}

if (toggle && header) {
  toggle.addEventListener("click", () => {
    const open = header.classList.toggle("nav-open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });

  header.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      header.classList.remove("nav-open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Open menu");
    });
  });
}

window.addEventListener(
  "scroll",
  () => {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 8);
  },
  { passive: true }
);

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const value = button.getAttribute("data-copy");
    if (!value) return;

    const original = button.textContent;
    try {
      await copyText(value);
      button.textContent = "Copied";
      button.classList.add("copied");
    } catch {
      button.textContent = "Copy failed";
    }

    window.setTimeout(() => {
      button.textContent = original;
      button.classList.remove("copied");
    }, 1800);
  });
});

/* Apple-like staggered scroll reveals */
function initReveals() {
  const items = Array.from(document.querySelectorAll(".reveal"));
  if (!items.length) return;

  // Stagger siblings inside common grids
  const groups = [
    ".bento",
    ".steps",
    ".stats",
    ".hero-cta",
    ".cta-actions",
    ".install-actions",
  ];

  groups.forEach((selector) => {
    document.querySelectorAll(selector).forEach((group) => {
      const children = group.querySelectorAll(":scope > .reveal, :scope > .tile, :scope > li, :scope > .stat, :scope > .btn");
      children.forEach((child, index) => {
        if (!child.classList.contains("reveal")) {
          child.classList.add("reveal");
        }
        child.style.setProperty("--delay", `${Math.min(index * 80, 320)}ms`);
      });
    });
  });

  const all = Array.from(document.querySelectorAll(".reveal"));

  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    all.forEach((el) => el.classList.add("is-inview"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-inview");
        observer.unobserve(entry.target);
      });
    },
    {
      root: null,
      rootMargin: "0px 0px -8% 0px",
      threshold: 0.12,
    }
  );

  all.forEach((el) => observer.observe(el));
}

const terminalLines = [
  { html: '<span class="term-prompt">$</span> agenc', delay: 320 },
  { html: '<span class="term-muted">AgenC runtime ready · session started</span>', delay: 480 },
  { html: '<span class="term-user">you</span> build a landing page and make it cook', delay: 700 },
  { html: '<span class="term-agent">agenc</span> Orienting repo · mapping landing/*', delay: 520 },
  { html: '<span class="term-agent">agenc</span> Writing <span class="term-file">landing/index.html</span>', delay: 560 },
  { html: '<span class="term-agent">agenc</span> Polishing <span class="term-file">styles.css</span> + terminal motion', delay: 560 },
  { html: '<span class="term-ok">✓</span> Landing ready · intent in, diff out', delay: 0 },
];

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function playTerminal() {
  const root = document.getElementById("terminal");
  if (!root) return;

  root.replaceChildren();

  if (prefersReducedMotion) {
    for (const line of terminalLines) {
      const p = document.createElement("p");
      p.className = "term-line is-visible";
      p.innerHTML = line.html;
      root.appendChild(p);
    }
    return;
  }

  for (const line of terminalLines) {
    const p = document.createElement("p");
    p.className = "term-line";
    p.innerHTML = line.html;
    root.appendChild(p);

    // force reflow so animation restarts cleanly
    void p.offsetWidth;
    p.classList.add("is-inview");
    p.classList.add("is-visible");

    if (line.delay) {
      const cursor = document.createElement("span");
      cursor.className = "term-cursor";
      cursor.setAttribute("aria-hidden", "true");
      p.appendChild(cursor);
      await sleep(line.delay);
      cursor.remove();
    }
  }
}

initReveals();
playTerminal();
