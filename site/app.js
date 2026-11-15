// Adds a copy button to every code block. No dependencies, no tracking. If the clipboard API
// is unavailable the page still works; the button just reports the failure.
const labels = document.documentElement.lang === "ru"
  ? { copy: "Копировать", copied: "Скопировано", failed: "Ошибка" }
  : { copy: "Copy", copied: "Copied", failed: "Failed" };

for (const pre of document.querySelectorAll("pre")) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.textContent = labels.copy;
  button.addEventListener("click", async () => {
    const code = pre.querySelector("code");
    const text = (code ?? pre).textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = labels.copied;
    } catch {
      button.textContent = labels.failed;
    }
    window.setTimeout(() => {
      button.textContent = labels.copy;
    }, 1500);
  });
  pre.append(button);
}

// Highlights the table-of-contents entry for the section currently in view.
const tocLinks = [...document.querySelectorAll('.toc a[href^="#"]')];
const tocSections = tocLinks
  .map((link) => document.getElementById(link.getAttribute("href").slice(1)))
  .filter(Boolean);

if (tocSections.length) {
  const updateActive = () => {
    const edge = window.scrollY + 140;
    let current = tocSections[0];
    for (const section of tocSections) {
      if (section.getBoundingClientRect().top + window.scrollY <= edge) {
        current = section;
      }
    }
    for (const link of tocLinks) {
      link.classList.toggle("active", link.getAttribute("href") === `#${current.id}`);
    }
  };
  updateActive();
  window.addEventListener("scroll", updateActive, { passive: true });
  window.addEventListener("resize", updateActive);
}
