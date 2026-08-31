function attachLedgerHandlers(rootEl) {
  const handlerRoot = rootEl || ledgerEl;
  handlerRoot.querySelectorAll(".bank-tag[data-id]").forEach((tag) => {
    tag.onclick = (ev) => {
      ev.stopPropagation();
      const e = entries.find((x) => x.id === tag.getAttribute("data-id"));
      if (!e) return;
      const oldBank = e.bank || "";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "bank-edit-input";
      input.value = e.bank || "";
      input.placeholder = "銀行";
      tag.replaceWith(input);
      input.focus();
      let cancelled = false;
      input.addEventListener("keydown", (ev2) => {
        if (ev2.key === "Enter") input.blur();
        else if (ev2.key === "Escape") {
          cancelled = true;
          input.blur();
        }
      });
      input.addEventListener("blur", async () => {
        if (!cancelled) {
          const newBank = input.value.trim();
          if (newBank !== oldBank) {
            ensureOriginalFields(e);
            e.bank = newBank;
            e.edited = true;
            await saveEntries([monthKeyOf(e.date)]);
          }
        }
        render();
      });
    };
  });
  handlerRoot.querySelectorAll(".del").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) return;
      const removed = entries[idx];
      const relatedSnapshot = {};
      entries.forEach((x) => {
        if (x.id === removed.id) return;
        const linkedToRemoved = x.matchedId === removed.id ||
          (removed.source === "invoice" && removed.invoiceNo &&
            x.source === "creditcard" && x.matchedId === removed.invoiceNo);
        if (linkedToRemoved) {
          relatedSnapshot[x.id] = {
            matchedId: x.matchedId ?? null,
            reviewed: !!x.reviewed,
            suggestedInvoiceNo: x.suggestedInvoiceNo ?? null,
          };
        }
      });
      entries.splice(idx, 1);
      const affectedMonths = new Set([monthKeyOf(removed.date)]);
      // Credit-card deletion unlinks all invoice items that pointed to it.
      if (removed.source === "creditcard") {
        entries.forEach((x) => {
          if (x.source === "invoice" && x.matchedId === removed.id) {
            x.matchedId = null;
            affectedMonths.add(monthKeyOf(x.date));
          }
        });
      }
      // Invoice deletion only unlinks the card when no other item from that invoice remains.
      if (
        removed.source === "invoice" && removed.invoiceNo && removed.matchedId
      ) {
        const stillHasMatchedSibling = entries.some((x) =>
          x.source === "invoice" && x.invoiceNo === removed.invoiceNo &&
          x.matchedId === removed.matchedId
        );
        if (!stillHasMatchedSibling) {
          const cc = entries.find((x) => x.id === removed.matchedId);
          if (cc) {
            cc.matchedId = null;
            cc.reviewed = false;
            cc.suggestedInvoiceNo = null;
            affectedMonths.add(monthKeyOf(cc.date));
          }
        }
      }
      await saveEntries(affectedMonths);
      render();
      showUndoToast("已刪除並同步解除相關配對", async () => {
        entries.push(removed);
        Object.entries(relatedSnapshot).forEach(([rid, state]) => {
          const x = entries.find((e) => e.id === rid);
          if (x) {
            x.matchedId = state.matchedId;
            x.reviewed = state.reviewed;
            x.suggestedInvoiceNo = state.suggestedInvoiceNo;
          }
        });
        await saveEntries();
        render();
        showToast("已復原");
      });
    };
  });
  handlerRoot.querySelectorAll(".cat-tag").forEach((tag) => {
    tag.onclick = (ev) => {
      ev.stopPropagation();
      const e = entries.find((x) => x.id === tag.getAttribute("data-id"));
      if (!e) return;
      // a plain <select> instead of click-to-cycle — with 11 categories now,
      // cycling one at a time could take up to 10 taps to reach the one you
      // want. A dropdown lets you jump straight to it.
      const select = document.createElement("select");
      select.className = "cat-select";
      CATEGORIES.forEach((cat) => {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        if (cat === e.category) opt.selected = true;
        select.appendChild(opt);
      });
      tag.replaceWith(select);
      select.focus();
      if (typeof select.showPicker === "function") {
        try {
          select.showPicker();
        } catch (err) {
          /* not supported in every browser — focus() above still lets the person open it manually */
        }
      }
      let committed = false;
      select.addEventListener("change", async () => {
        committed = true;
        e.category = select.value;
        e.categoryManual = true;
        e.categoryReviewed = true;
        await saveEntries([monthKeyOf(e.date)]);
        render();
      });
      select.addEventListener("blur", () => {
        if (!committed) render();
      });
    };
  });
  handlerRoot.querySelectorAll(".confirm-btn").forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const e = entries.find((x) => x.id === btn.getAttribute("data-id"));
      if (!e) return;
      e.reviewed = true;
      await saveEntries([monthKeyOf(e.date)]);
      render();
      showToast("已確認");
    };
  });
  handlerRoot.querySelectorAll(".merge-btn").forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const cc = entries.find((x) => x.id === btn.getAttribute("data-id"));
      const no = btn.getAttribute("data-no");
      if (!cc || !no) return;
      const items = entries.filter((e) =>
        e.source === "invoice" && e.invoiceNo === no && !e.matchedId
      );
      if (items.length === 0) {
        showToast("這張發票已經被其他項目比對走了");
        return;
      }
      items.forEach((item) => item.matchedId = cc.id);
      cc.matchedId = no;
      cc.reviewed = true;
      cc.suggestedInvoiceNo = null;
      // remember this vendor pairing so future exact-amount matches for the
      // same store auto-merge instead of asking again every time
      learnVendorAlias(cc.vendor || cc.note, items[0].vendor);
      await saveVendorAliases();
      // cc's date and the invoice items' dates can differ (matches are
      // allowed up to ±6 days apart, which can cross a month boundary), so
      // the affected set is the union of both sides, not just cc's month.
      const affectedMonths = new Set([
        monthKeyOf(cc.date),
        ...items.map((i) => monthKeyOf(i.date)),
      ]);
      await saveEntries(affectedMonths);
      render();
      showToast("已合併");
    };
  });
  handlerRoot.querySelectorAll(".reject-btn").forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const cc = entries.find((x) => x.id === btn.getAttribute("data-id"));
      if (!cc) return;
      const rejectedNo = cc.suggestedInvoiceNo;
      if (rejectedNo) {
        if (!Array.isArray(cc.rejectedInvoiceNos)) cc.rejectedInvoiceNos = [];
        if (!cc.rejectedInvoiceNos.includes(rejectedNo)) {
          cc.rejectedInvoiceNos.push(rejectedNo);
        }
      }
      cc.suggestedInvoiceNo = null;
      cc.reviewed = true;
      await saveEntries([monthKeyOf(cc.date)]);
      render();
    };
  });
  handlerRoot.querySelectorAll(".unmatch-btn").forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const ccId = btn.getAttribute("data-id");
      const invoiceNo = btn.getAttribute("data-no");
      if (!window.confirm("確定要解除這筆信用卡與發票的配對嗎？")) return;
      const result = unmatchReconciliation(ccId, invoiceNo);
      if (!result) {
        showToast("找不到可解除的配對");
        return;
      }
      await saveEntries(result.affectedMonths);
      if (result.aliasRemoved) await saveVendorAliases();
      render();
      showToast("已解除配對，並記住不再建議此組合");
    };
  });

  const batchBtn = handlerRoot.querySelector(".batch-confirm-btn");
  if (batchBtn) {
    batchBtn.onclick = async (ev) => {
      ev.stopPropagation();
      let n = 0;
      const affectedMonths = new Set();
      entries.forEach((e) => {
        if (
          e.source === "creditcard" && !e.matchedId && !e.reviewed &&
          !e.suggestedInvoiceNo
        ) {
          e.reviewed = true;
          n++;
          affectedMonths.add(monthKeyOf(e.date));
        }
      });
      await saveEntries(affectedMonths);
      render();
      showToast(`已批次確認 ${n} 筆`);
    };
  }

  handlerRoot.querySelectorAll(".month-head").forEach((head) => {
    head.onclick = () => {
      const mk = head.getAttribute("data-month");
      if (expandedMonths.has(mk)) expandedMonths.delete(mk);
      else expandedMonths.add(mk);
      render();
    };
  });

  // click-to-edit: amount. Swaps the static span for a number input; commits
  // on blur/Enter, discards on Escape. Amount edits can shift totals (e.g.
  // splitting a shared bill down to just the user's share), so a full
  // render() follows every commit to keep day/month totals in sync.
  handlerRoot.querySelectorAll(".amt").forEach((span) => {
    span.onclick = (ev) => {
      ev.stopPropagation();
      const e = entries.find((x) => x.id === span.getAttribute("data-id"));
      if (!e) return;
      const oldAmount = e.amount;
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.className = "amt-edit-input";
      input.value = e.amount;
      span.replaceWith(input);
      input.focus();
      input.select();
      let cancelled = false;
      input.addEventListener("keydown", (ev2) => {
        if (ev2.key === "Enter") input.blur();
        else if (ev2.key === "Escape") {
          cancelled = true;
          input.blur();
        }
      });
      input.addEventListener("blur", async () => {
        if (!cancelled) {
          const val = parseFloat(input.value);
          // 允許改成 0——用於「這張發票是代付，其中某幾項其實是別人的」
          // 這種情境：金額歸零但保留這筆項目本身，不用整筆刪除，也不會
          // 被算進總額（fmt(0) 顯示 $0，isCounted 邏輯不受影響，加總自然
          // 是 0）。唯一要擋的是「不是數字」（NaN，代表輸入框裡打的不是
          // 有效數字）。
          if (!isNaN(val) && val !== oldAmount) {
            ensureOriginalFields(e);
            e.amount = val;
            e.edited = true;
            await saveEntries([monthKeyOf(e.date)]);
            render();
            showUndoToast(
              val === 0
                ? "金額已改為 $0(代付/非本人項目)"
                : `金額已改為 ${fmt(val)}`,
              async () => {
                e.amount = oldAmount;
                await saveEntries([monthKeyOf(e.date)]);
                render();
                showToast("已復原");
              },
            );
            return;
          }
        }
        render();
      });
    };
  });

  // click-to-edit: note. Lets the user record why an amount was adjusted
  // (e.g. "扣掉室友那份" for a shared bill split down to their own share).
  handlerRoot.querySelectorAll(".note").forEach((span) => {
    span.onclick = (ev) => {
      ev.stopPropagation();
      const e = entries.find((x) => x.id === span.getAttribute("data-id"));
      if (!e) return;
      const oldNote = e.note || "";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "note-edit-input";
      input.value = e.note || "";
      input.placeholder = "新增備註";
      span.replaceWith(input);
      input.focus();
      let cancelled = false;
      input.addEventListener("keydown", (ev2) => {
        if (ev2.key === "Enter") input.blur();
        else if (ev2.key === "Escape") {
          cancelled = true;
          input.blur();
        }
      });
      input.addEventListener("blur", async () => {
        if (!cancelled) {
          const newNote = input.value.trim();
          if (newNote !== oldNote) {
            ensureOriginalFields(e);
            e.note = newNote;
            e.edited = true;
            await saveEntries([monthKeyOf(e.date)]);
            render();
            showUndoToast(newNote ? "備註已更新" : "備註已清空", async () => {
              e.note = oldNote;
              await saveEntries([monthKeyOf(e.date)]);
              render();
              showToast("已復原");
            });
            return;
          }
        }
        render();
      });
    };
  });
}

async function addEntry() {
  if (!dataLoaded) {
    showToast("資料載入中,請稍等一下再試");
    return;
  }
  const amount = parseFloat(amountInput.value);
  if (!amount || amount <= 0) {
    showToast("請輸入金額");
    amountInput.focus();
    return;
  }
  saveBtn.disabled = true;
  saveBtn.textContent = "儲存中…";
  const now = new Date();
  const todayKey = toKey(now);
  const pickedKey = dateInput.value || todayKey;
  // today: keep the real current time, so several cash entries logged
  // today still sort by actual time-of-day within the day. A backfilled
  // past date has no meaningful time-of-day to preserve, so noon is just a
  // stable, unambiguous point within that date.
  const entryDate = pickedKey === todayKey
    ? now
    : new Date(pickedKey + "T12:00:00");
  const newEntry = {
    id: "e" + now.getTime() + Math.random().toString(36).slice(2, 7),
    amount,
    originalAmount: amount,
    category: selectedCategory,
    note: noteInput.value.trim(),
    originalNote: noteInput.value.trim(),
    originalVendor: "",
    originalBank: "",
    date: toKey(entryDate),
    ts: entryDate.getTime(),
    source: "cash",
    vendor: "",
    matchedId: null,
    reviewed: true,
    categoryManual: true,
    categoryReviewed: true,
  };
  entries.push(newEntry);
  try {
    await saveEntries([monthKeyOf(toKey(entryDate))]);
    amountInput.value = "";
    noteInput.value = "";
    if (expandedMonths) expandedMonths.add(monthKeyOf(newEntry.date));
    closeCashEntry();
    render();
    showToast(
      "已記錄 " + fmt(amount) +
        (pickedKey === todayKey ? "" : `(${dateLabel(pickedKey)})`),
    );
    amountInput.focus();
  } catch (error) {
    entries = entries.filter((entry) => entry.id !== newEntry.id);
    render();
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "記一筆現金";
  }
}
