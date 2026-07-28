(() => {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const header = document.getElementById("header");
  const onScroll = () => {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 8);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const toggle = document.querySelector(".menu-toggle");
  const mobileNav = document.getElementById("mobile-nav");
  if (toggle && mobileNav) {
    const setOpen = (open) => {
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      mobileNav.classList.toggle("open", open);
      document.body.style.overflow = open ? "hidden" : "";
    };

    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      setOpen(open);
    });

    mobileNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => setOpen(false));
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
  }

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const value = btn.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(value);
        const prev = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("copied");
        window.setTimeout(() => {
          btn.textContent = prev;
          btn.classList.remove("copied");
        }, 1600);
      } catch {
        btn.textContent = "Failed";
        window.setTimeout(() => {
          btn.textContent = "Copy";
        }, 1400);
      }
    });
  });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const reveals = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("visible"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("visible");
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    reveals.forEach((el) => io.observe(el));
  }

  const terminal = document.getElementById("terminal");
  if (!terminal) return;

  const script = [
    { cls: "prompt", text: "$ agenc" },
    { cls: "dim", text: "daemon ready · workspace mapped · 428 files" },
    { cls: "user", text: "› build a landing page for the product" },
    { cls: "agent", text: "planning → explore repo structure, brand tokens, existing assets" },
    { cls: "tool", text: "→ Orient  “landing page frontend website UI”" },
    { cls: "out", text: "  found landing/ · logo-mark.svg · install path" },
    { cls: "tool", text: "→ Write   landing/index.html" },
    { cls: "tool", text: "→ Write   landing/styles.css" },
    { cls: "tool", text: "→ Write   landing/script.js" },
    { cls: "agent", text: "spawning verification · checks layout + a11y + motion prefs" },
    { cls: "ok", text: "✓ hero, features, workflow, install, terminal demo" },
    { cls: "ok", text: "✓ reduced-motion safe · mobile nav · copy install" },
    { cls: "dim", text: "diff ready · intent in · ship out" },
    { cls: "prompt", text: "$ █" },
  ];

  const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));

  const appendLine = (cls, text) => {
    const line = document.createElement("p");
    line.className = `term-line ${cls}`;
    line.textContent = text;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
    return line;
  };

  const typeLine = async (cls, text) => {
    const line = document.createElement("p");
    line.className = `term-line ${cls}`;
    terminal.appendChild(line);

    if (reduceMotion) {
      line.textContent = text;
      return;
    }

    let out = "";
    for (const ch of text) {
      out += ch;
      line.textContent = out;
      terminal.scrollTop = terminal.scrollHeight;
      await sleep(cls === "user" ? 18 : cls === "prompt" ? 28 : 8);
    }
  };

  const runTerminal = async () => {
    terminal.innerHTML = "";
    for (const step of script) {
      if (step.cls === "user" || step.cls === "prompt") {
        await typeLine(step.cls, step.text.replace(/█$/, ""));
        if (step.text.endsWith("█")) {
          const cursor = document.createElement("span");
          cursor.className = "term-cursor";
          cursor.setAttribute("aria-hidden", "true");
          const last = terminal.lastElementChild;
          if (last) last.appendChild(cursor);
        }
      } else {
        appendLine(step.cls, step.text);
        if (!reduceMotion) await sleep(220 + Math.random() * 180);
      }
      if (!reduceMotion) await sleep(90);
    }
  };

  if (reduceMotion) {
    runTerminal();
  } else if ("IntersectionObserver" in window) {
    const tio = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        tio.disconnect();
        runTerminal();
      },
      { threshold: 0.25 }
    );
    tio.observe(terminal);
  } else {
    runTerminal();
  }
})();
