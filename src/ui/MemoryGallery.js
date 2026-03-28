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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    this.memories = [];
    this.onBack = null;
    this.onDiaryEdit = null;
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
    if (this.container) {
      this.container.addEventListener("click", (event) => {
        const editBtn = event.target?.closest?.(".memory-edit-btn[data-edit-field]");
        if (!editBtn) return;
        const card = editBtn.closest(".memory-card[data-memory-id]");
        const field = editBtn.getAttribute("data-edit-field");
        if (!card || !field) return;
        event.preventDefault();
        this._startFieldEdit(card, field);
      });

      this.container.addEventListener("focusout", (event) => {
        const input = event.target?.closest?.(".memory-edit-input[data-edit-input]");
        if (!input) return;
        const card = input.closest(".memory-card[data-memory-id]");
        const field = input.getAttribute("data-edit-input");
        if (!card || !field) return;
        if (input.dataset.cancelEdit === "1") {
          delete input.dataset.cancelEdit;
          return;
        }
        this._commitFieldEdit(card, field);
      });

      this.container.addEventListener("keydown", (event) => {
        const input = event.target?.closest?.(".memory-edit-input[data-edit-input]");
        if (!input) return;
        const card = input.closest(".memory-card[data-memory-id]");
        const field = input.getAttribute("data-edit-input");
        if (!card || !field) return;

        if (event.key === "Escape") {
          event.preventDefault();
          input.dataset.cancelEdit = "1";
          this._cancelFieldEdit(card, field);
          return;
        }

        if (field === "title" && event.key === "Enter") {
          event.preventDefault();
          this._commitFieldEdit(card, field);
          return;
        }

        if (field === "summary" && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          this._commitFieldEdit(card, field);
        }
      });
    }
  }

  setOnBack(handler) {
    this.onBack = typeof handler === "function" ? handler : null;
  }

  setOnDiaryEdit(handler) {
    this.onDiaryEdit = typeof handler === "function" ? handler : null;
  }

  async render(memories, resolveAsset) {
    const token = ++this.renderToken;
    this.clear();
    if (!this.container) return;

    const list = Array.isArray(memories) ? memories : [];
    this.memories = [...list];
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
      const safeTitle = escapeHtml(title);
      const safeSummary = escapeHtml(summary);
      const timeText = escapeHtml(formatMemoryTime(record?.createdAt));
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
                    <p>${escapeHtml(entry.text)}</p>
                  </div>
                </div>
              `;
            })
            .join("")
        : `<div class="chat-row ai"><div class="chat-bubble bubble-ai"><p>No transcript.</p></div></div>`;

      const imageHtml = imageSrc
        ? `<img src="${imageSrc}" alt="${safeTitle}" class="memory-image">`
        : `<div class="memory-image memory-image--fallback"></div>`;

      this.container.insertAdjacentHTML(
        "beforeend",
        `
          <article class="glass-card memory-card" data-memory-id="${escapeHtml(record?.id || "")}">
            <div class="memory-image-wrap">
              ${imageHtml}
              <div class="memory-image-shade"></div>
            </div>
            <div class="memory-head">
              <div class="memory-title-row memory-editable" data-editable-field="title">
                <div class="memory-title-copy">
                  <h2 class="memory-title" data-field-display="title">${safeTitle}</h2>
                  <input
                    class="memory-edit-input memory-edit-input--title"
                    data-edit-input="title"
                    type="text"
                    value="${safeTitle}"
                    hidden
                    aria-label="Edit memory title"
                  >
                </div>
                <button class="memory-edit-btn" type="button" data-edit-field="title" aria-label="Edit memory title">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 20h9"/>
                    <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                  </svg>
                </button>
              </div>
              <div class="memory-time">${timeText}</div>
              <div class="memory-summary-row memory-editable" data-editable-field="summary">
                <div class="memory-edit-header">
                  <span class="memory-edit-kicker">Daily Summary</span>
                  <button class="memory-edit-btn" type="button" data-edit-field="summary" aria-label="Edit daily summary">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 20h9"/>
                      <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
                    </svg>
                  </button>
                </div>
                <p class="memory-summary" data-field-display="summary">${safeSummary}</p>
                <textarea
                  class="memory-edit-input memory-edit-input--summary"
                  data-edit-input="summary"
                  hidden
                  aria-label="Edit daily summary"
                >${safeSummary}</textarea>
              </div>
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
    this.memories = [];
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

  _findMemorySource(memoryId) {
    return this.memories.find((memory) => {
      const record = memory?.record ?? memory;
      return record?.id === memoryId;
    });
  }

  _getFieldElements(card, field) {
    const display = card?.querySelector?.(`[data-field-display="${field}"]`);
    const input = card?.querySelector?.(`[data-edit-input="${field}"]`);
    const editable = card?.querySelector?.(`.memory-editable[data-editable-field="${field}"]`);
    return { display, input, editable };
  }

  _startFieldEdit(card, field) {
    const { display, input, editable } = this._getFieldElements(card, field);
    if (!display || !input || !editable) return;
    if (!input.hidden) {
      input.focus();
      return;
    }

    input.dataset.originalValue = display.textContent ?? "";
    input.value = display.textContent ?? "";
    display.hidden = true;
    input.hidden = false;
    editable.classList.add("is-editing");
    card.classList.add("is-editing");

    requestAnimationFrame(() => {
      input.focus();
      const length = input.value.length;
      if (typeof input.setSelectionRange === "function") {
        input.setSelectionRange(length, length);
      }
    });
  }

  _cancelFieldEdit(card, field) {
    const { display, input, editable } = this._getFieldElements(card, field);
    if (!display || !input || !editable) return;
    input.value = input.dataset.originalValue ?? display.textContent ?? "";
    input.hidden = true;
    display.hidden = false;
    editable.classList.remove("is-editing");
    card.classList.remove("is-editing");
  }

  async _commitFieldEdit(card, field) {
    const { display, input, editable } = this._getFieldElements(card, field);
    if (!display || !input || !editable || input.hidden) return;

    const memoryId = card.getAttribute("data-memory-id");
    const originalValue = input.dataset.originalValue ?? display.textContent ?? "";
    const trimmedValue = input.value.replace(/\r\n/g, "\n").trim();
    const nextValue = field === "title" ? trimmedValue || "Untitled Memory" : trimmedValue;

    input.hidden = true;
    display.hidden = false;
    editable.classList.remove("is-editing");
    card.classList.remove("is-editing");

    if (nextValue === originalValue.trim()) {
      display.textContent = field === "title" ? nextValue : originalValue;
      return;
    }

    const source = this._findMemorySource(memoryId);
    const record = source?.record ?? source;
    if (!record) {
      display.textContent = originalValue;
      return;
    }

    display.textContent = nextValue;
    const nextRecord = {
      ...record,
      diaryCard: {
        ...(record.diaryCard || {}),
        [field]: nextValue,
      },
    };

    if (source?.record) {
      source.record = nextRecord;
    } else {
      Object.assign(source, nextRecord);
    }

    try {
      if (this.onDiaryEdit) {
        await this.onDiaryEdit(nextRecord, { field, value: nextValue });
      }
    } catch (err) {
      console.warn("Failed to persist diary edit", err);
      display.textContent = originalValue;
      if (source?.record) {
        source.record = record;
      } else {
        Object.assign(source, record);
      }
      window.alert("Could not update this memory right now.");
    }
  }
}
