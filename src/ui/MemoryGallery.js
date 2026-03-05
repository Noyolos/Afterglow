function parseTranscript(transcriptText) {
  if (typeof transcriptText !== "string" || !transcriptText.trim()) return [];
  return transcriptText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith("User:")) {
        return { role: "user", text: line.replace(/^User:\s*/, "").trim() };
      }
      if (line.startsWith("Afterglow:")) {
        return { role: "ai", text: line.replace(/^Afterglow:\s*/, "").trim() };
      }
      return { role: "ai", text: line };
    });
}

function formatMemoryTime(isoDate) {
  const date = isoDate ? new Date(isoDate) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export class MemoryGallery {
  constructor() {
    this.view = document.getElementById("view-gallery");
    this.container = document.getElementById("gallery-container");
    this.btnLeft = document.getElementById("nav-left");
    this.btnRight = document.getElementById("nav-right");
    this.backBtn = document.getElementById("btn-back-to-calendar");
    this.scrollStep = 382;
    this.objectUrls = [];
    this.cards = [];
    this.renderToken = 0;
    this.onBack = null;
    this._boundScrollFrame = null;

    this.bindEvents();
  }

  bindEvents() {
    if (this.btnLeft) {
      this.btnLeft.addEventListener("click", () => {
        if (!this.btnLeft.disabled) {
          this.container?.scrollBy({ left: -this.scrollStep, behavior: "smooth" });
        }
      });
    }
    if (this.btnRight) {
      this.btnRight.addEventListener("click", () => {
        if (!this.btnRight.disabled) {
          this.container?.scrollBy({ left: this.scrollStep, behavior: "smooth" });
        }
      });
    }
    if (this.container) {
      this.container.addEventListener("scroll", () => {
        if (this._boundScrollFrame) return;
        this._boundScrollFrame = requestAnimationFrame(() => {
          this._boundScrollFrame = null;
          this.update3DEffect();
          this.updateNavButtons();
        });
      });
    }
    if (this.backBtn) {
      this.backBtn.addEventListener("click", (event) => {
        event.preventDefault();
        if (typeof this.onBack === "function") this.onBack();
      });
    }
  }

  setOnBack(handler) {
    this.onBack = typeof handler === "function" ? handler : null;
  }

  async render(memories, resolveAsset) {
    const token = ++this.renderToken;
    this.clear();
    if (!this.container) return;

    const list = Array.isArray(memories) ? memories : [];
    if (!list.length) {
      this.container.insertAdjacentHTML(
        "beforeend",
        `
          <article class="glass-card memory-card memory-card--empty">
            <div class="memory-head">
              <h2 class="memory-title">No Memory Today</h2>
              <div class="memory-time">Save one memory to anchor this date.</div>
            </div>
          </article>
        `
      );
      this.cards = Array.from(this.container.querySelectorAll("article"));
      this.update3DEffect();
      this.updateNavButtons();
      return;
    }

    for (const memory of list) {
      if (token !== this.renderToken) return;
      const record = memory?.record ?? memory;
      const diary = record?.diaryCard ?? {};
      const title = diary.title || "Untitled Memory";
      const summary = diary.summary || "";
      const timeText = formatMemoryTime(record?.createdAt);
      const transcript = parseTranscript(record?.transcript || "");
      const assetKey = record?.assets?.renderKey || record?.assets?.thumbKey || "";
      const imageSrc = await this._resolveAssetUrl(assetKey, resolveAsset);
      if (token !== this.renderToken) return;

      const chatHtml = transcript.length
        ? transcript
            .slice(0, 8)
            .map((entry) => {
              const roleClass = entry.role === "user" ? "bubble-user" : "bubble-ai";
              const wrapClass = entry.role === "user" ? "chat-row user" : "chat-row ai";
              return `
                <div class="${wrapClass}">
                  <div class="chat-bubble ${roleClass}">
                    <p>${entry.text}</p>
                  </div>
                </div>
              `;
            })
            .join("")
        : `<div class="chat-row ai"><div class="chat-bubble bubble-ai"><p>No transcript.</p></div></div>`;

      const imageHtml = imageSrc
        ? `<img src="${imageSrc}" alt="${title}" class="memory-image">`
        : `<div class="memory-image memory-image--fallback"></div>`;

      this.container.insertAdjacentHTML(
        "beforeend",
        `
          <article class="glass-card memory-card">
            <div class="memory-image-wrap">
              ${imageHtml}
              <div class="memory-image-shade"></div>
            </div>
            <div class="memory-head">
              <h2 class="memory-title">${title}</h2>
              <div class="memory-time">${timeText}</div>
              <p class="memory-summary">${summary}</p>
            </div>
            <div class="memory-divider"></div>
            <div class="memory-chat chat-scroll">${chatHtml}</div>
          </article>
        `
      );
    }

    this.cards = Array.from(this.container.querySelectorAll("article"));
    this.container.scrollLeft = 0;
    requestAnimationFrame(() => {
      this.update3DEffect();
      this.updateNavButtons();
    });
  }

  async _resolveAssetUrl(assetKey, resolveAsset) {
    if (!assetKey || typeof resolveAsset !== "function") return "";
    try {
      const asset = await resolveAsset(assetKey);
      const blob = asset instanceof Blob ? asset : asset?.blob;
      if (!(blob instanceof Blob)) return "";
      const url = URL.createObjectURL(blob);
      this.objectUrls.push(url);
      return url;
    } catch (err) {
      console.warn("Failed to resolve gallery asset", err);
      return "";
    }
  }

  update3DEffect() {
    if (!this.container || !this.cards.length) return;
    const containerCenter = this.container.scrollLeft + this.container.clientWidth / 2;

    this.cards.forEach((card) => {
      const cardCenter = card.offsetLeft + card.clientWidth / 2;
      const distance = cardCenter - containerCenter;
      const offset = Math.max(-1.5, Math.min(1.5, distance / 400));
      const rotateY = offset * 40;
      const scale = 1 - Math.abs(offset) * 0.12;
      const translateZ = Math.abs(offset) * -80;

      card.style.transform = `perspective(1000px) translateZ(${translateZ}px) rotateY(${rotateY}deg) scale(${scale})`;
      card.style.opacity = String(Math.max(0.3, 1 - Math.abs(offset) * 0.5));
      card.style.zIndex = String(Math.round(100 - Math.abs(distance)));
    });
  }

  updateNavButtons() {
    if (!this.container || !this.cards.length) {
      if (this.btnLeft) this.btnLeft.disabled = true;
      if (this.btnRight) this.btnRight.disabled = true;
      return;
    }

    const containerCenter = this.container.scrollLeft + this.container.clientWidth / 2;
    const firstCardCenter = this.cards[0].offsetLeft + this.cards[0].clientWidth / 2;
    const lastCardCenter = this.cards[this.cards.length - 1].offsetLeft + this.cards[this.cards.length - 1].clientWidth / 2;

    if (this.btnLeft) this.btnLeft.disabled = containerCenter <= firstCardCenter + 10;
    if (this.btnRight) this.btnRight.disabled = containerCenter >= lastCardCenter - 10;
  }

  clear() {
    if (this.container) this.container.innerHTML = "";
    this.cards = [];
    this.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.objectUrls = [];
  }

  show() {
    if (!this.view) return;
    this.view.classList.remove("view-hidden");
    this.view.classList.add("view-visible");
    this.view.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      this.update3DEffect();
      this.updateNavButtons();
    });
  }

  hide() {
    if (!this.view) return;
    this.view.classList.remove("view-visible");
    this.view.classList.add("view-hidden");
    this.view.setAttribute("aria-hidden", "true");
  }
}
