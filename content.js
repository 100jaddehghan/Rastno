(() => {
  if (globalThis.rastnoLoaded) return;
  globalThis.rastnoLoaded = true;

  const frameOrigin = /^https?:$/.test(location.protocol)
    ? location.origin
    : globalThis.origin === "null" ? location.ancestorOrigins[0] : globalThis.origin;
  if (!/^https?:\/\//.test(frameOrigin ?? "")) return;
  const site = new URL(frameOrigin);
  const key = "rastno:" + site.protocol + "//" + site.hostname;
  const scopeKey = key + ":scope";
  const sizeKey = key + ":size";
  const spacingKey = key + ":spacing";
  const marker = "data-rastno-direction";
  const sizeMarker = "data-rastno-size";
  const spacingMarker = "data-rastno-spacing";
  const editor = 'textarea, input:is(:not([type]), [type="text"], [type="search"]), [contenteditable]:not([contenteditable="false"])';
  const list = 'ol, ul';
  const textBlock = 'p, li, ol, ul, blockquote, h1, h2, h3, h4, h5, h6, td, th, label, div, span';
  const excluded = 'pre, code, kbd, samp, [role="code"], nav, [role="navigation"], [role="menu"], svg, script, style';
  const protectedText = 'a, pre, code, kbd, samp, [role="code"]';
  const blockChildren = 'p, li, ul, ol, div, section, article, blockquote, table, h1, h2, h3, h4, h5, h6, textarea, input, button';
  const dirty = new Set();
  const overrides = new WeakMap();
  const shadowObservers = new Map();
  const watchOptions = {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["contenteditable", "type"]
  };
  let shadowStyle;
  let frame = 0;
  let active = false;
  let scope = "both";
  let size = "default";
  let spacing = "default";
  let previewHost;
  const changedKeys = new Set();

  function isRtl(text) {
    const firstLetter = text.match(/\p{Letter}/u)?.[0];
    const rtlLetter = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
    if (!firstLetter) return false;
    if (rtlLetter.test(firstLetter)) return true;

    // A short English opening or list label should not set the direction of Persian prose.
    const words = text.match(/\p{Letter}(?:[\p{Letter}\p{Mark}\u200c\u200d]|['’](?=\p{Letter}))*/gu);
    const rtlWords = words.filter(word => rtlLetter.test(word[0])).length;
    return rtlWords >= 2 && rtlWords * 3 >= words.length;
  }

  function getText(element) {
    if (element.matches("input, textarea")) return element.value;
    if (!element.querySelector("pre, code, kbd, samp, [role=code]")) return element.textContent;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement.closest(excluded)) text += node.data;
    }
    return text;
  }

  function update(element) {
    if (!element.isConnected) return;
    const editable = element.matches(editor);
    const manual = editable && scope !== "reading" ? overrides.get(element) : undefined;
    const container = element.parentElement?.closest(editor);
    const block = element.matches(list) ||
      (element.matches(textBlock) && !element.querySelector(blockChildren));
    const inScope = editable ? scope !== "reading" : scope !== "typing" && block && !container;
    const eligible = inScope && !element.closest(excluded);
    const rtlText = eligible && isRtl(getText(element));
    const direction = eligible ? manual ?? (rtlText ? "rtl" : null) : null;
    if (direction) element.setAttribute(marker, direction);
    else if (element.hasAttribute(marker)) element.removeAttribute(marker);
    if (rtlText && size !== "default") element.setAttribute(sizeMarker, size);
    else if (element.hasAttribute(sizeMarker)) element.removeAttribute(sizeMarker);
    if (rtlText && spacing !== "default") element.setAttribute(spacingMarker, spacing);
    else if (element.hasAttribute(spacingMarker)) element.removeAttribute(spacingMarker);
  }

  function clearMarks(root) {
    root.querySelectorAll("[" + marker + "], [" + sizeMarker + "], [" + spacingMarker + "]").forEach(element => {
      element.removeAttribute(marker);
      element.removeAttribute(sizeMarker);
      element.removeAttribute(spacingMarker);
    });
  }

  function scan(root) {
    if (root instanceof Element) update(root);
    root.querySelectorAll(textBlock + ", " + editor + ", [" + marker + "]").forEach(update);
  }

  function getShadow(element) {
    if (!(element instanceof HTMLElement)) return null;
    return element.shadowRoot ?? chrome.dom?.openOrClosedShadowRoot(element);
  }

  function watchShadow(root) {
    if (!root || root.host === previewHost || shadowObservers.has(root)) return;
    const watcher = new MutationObserver(onMutations);
    shadowObservers.set(root, watcher);
    watcher.observe(root, watchOptions);
    root.addEventListener("input", onInput, true);
    root.addEventListener("compositionend", onInput, true);
    discoverShadows(root);
    scan(root);
    shadowStyle ??= fetch(chrome.runtime.getURL("rtl.css")).then(async response => {
      if (!response.ok) throw new Error("Could not load extension stylesheet");
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(await response.text());
      return sheet;
    }).catch(error => {
      console.warn("Rastno could not style shadow editors.", error);
      return null;
    });
    shadowStyle.then(sheet => {
      if (sheet && shadowObservers.has(root) && !root.adoptedStyleSheets.includes(sheet)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      }
    });
  }

  function discoverShadows(root) {
    if (root instanceof Element) watchShadow(getShadow(root));
    root.querySelectorAll("*").forEach(element => watchShadow(getShadow(element)));
  }

  function releaseShadow(root, watcher) {
    watcher.disconnect();
    root.removeEventListener("input", onInput, true);
    root.removeEventListener("compositionend", onInput, true);
    clearMarks(root);
    shadowObservers.delete(root);
  }

  function queue(element) {
    if (!active || !element) return;
    dirty.add(element);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const batch = new Set(dirty);
      dirty.clear();
      for (const root of batch) {
        let ancestor = root.parentElement;
        while (ancestor && !batch.has(ancestor)) ancestor = ancestor.parentElement;
        if (!ancestor) scan(root);
        ancestor = root.parentElement;
        while (ancestor?.matches(textBlock)) {
          update(ancestor);
          if (ancestor.matches("div, td, th, blockquote")) {
            const enclosingList = ancestor.closest(list);
            if (enclosingList) update(enclosingList);
            break;
          }
          ancestor = ancestor.parentElement;
        }
        const editable = root.closest?.(editor);
        if (editable) update(editable);
      }
    });
  }

  function onMutations(records) {
    for (const record of records) {
      queue(record.target instanceof Text ? record.target.parentElement ?? record.target.getRootNode() : record.target);
      for (const added of record.addedNodes) {
        if (added instanceof Element) discoverShadows(added);
      }
    }
    for (const [root, watcher] of shadowObservers) {
      if (!root.host.isConnected) releaseShadow(root, watcher);
    }
  }

  const observer = new MutationObserver(onMutations);

  function onInput(event) {
    const editable = event.composedPath()[0]?.closest?.(editor);
    if (editable && !event.isComposing) update(editable);
  }

  function deepFocus() {
    let target = document.activeElement;
    let nested = getShadow(target)?.activeElement;
    while (nested) {
      target = nested;
      nested = getShadow(target)?.activeElement;
    }
    return target;
  }

  function cycleDirection(focused) {
    const current = overrides.get(focused);
    if (current === "ltr") overrides.delete(focused);
    else overrides.set(focused, current === "rtl" ? "ltr" : "rtl");
    update(focused);
  }

  function selectionAt(target) {
    const root = target?.getRootNode();
    return root instanceof ShadowRoot ? root.getSelection() : document.getSelection();
  }

  function selectedText(focused, selection) {
    if (focused?.matches("textarea, input") && focused.selectionStart != null) {
      return focused.value.slice(focused.selectionStart, focused.selectionEnd);
    }
    return selection?.toString() ?? "";
  }

  function cleanPersian(text) {
    return text.replaceAll("ي", "ی").replaceAll("ك", "ک")
      .replace(/[ \u00a0]{2,}/g, " ");
  }

  function localizeNumbers(text) {
    const digits = "۰۱۲۳۴۵۶۷۸۹";
    // Limit conversion to standalone numbers in prose. Structured tokens are preserved.
    return text.split(/(`+[\s\S]*?`+|(?:#[ \t]*|\b[A-Z][A-Z0-9]+[ \t]*-[ \t]*)[0-9٠-٩]+|\b(?:[0-9]+\.){3}[0-9]+\b)/gu)
      .map((part, index) => index % 2 ? part : part.replace(
        /(^|[\s(«])([0-9٠-٩]+(?:[.,٫٬:][0-9٠-٩]+)*)(?=$|[\s،؛؟)»]|[,.!](?:\s|$))/gu,
      (_, prefix, number) => prefix + number.replace(/[0-9٠-٩]/gu,
        digit => digits[digit >= "٠" ? digit.charCodeAt(0) - 0x660 : Number(digit)]))).join("");
  }

  function canEditSelection(focused, selection, allowCaret = false) {
    if (!focused || focused.closest(excluded + ", a")) return false;
    if (focused.matches("textarea, input")) return !focused.readOnly && !focused.disabled;
    if (!focused.isContentEditable || !selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const element = node instanceof Element ? node : node.parentElement;
    return (node instanceof Text || (allowCaret && range.collapsed)) &&
      node === range.endContainer && focused.contains(node) && !element?.closest(excluded + ", a");
  }

  function localizeDomSelection(selection, text) {
    if (!selection?.rangeCount) return localizeNumbers(text);
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node instanceof Element ? node : node.parentElement;
    if (element?.closest(protectedText)) return text;
    const fragment = range.cloneContents();
    if (!fragment.querySelector(protectedText)) return localizeNumbers(text);
    if (fragment.textContent !== text) return text;
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    let result = "";
    let ordinary = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest(protectedText)) {
        result += localizeNumbers(ordinary) + node.data;
        ordinary = "";
      } else {
        ordinary += node.data;
      }
    }
    return result + localizeNumbers(ordinary);
  }

  function preview(text, converted, editable, onConfirm) {
    if (previewHost) return;
    const host = document.createElement("div");
    previewHost = host;
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      dialog { width: min(480px, 88vw); padding: 20px; border: 1px solid #426660;
        border-radius: 16px; background: #17252a; color: #eef8f5;
        font: 14px/1.65 "Segoe UI", Tahoma, sans-serif; }
      dialog::backdrop { background: #081410b8; }
      h2 { margin: 0 0 12px; font-size: 18px; }
      p { margin: 4px 0; }
      pre { max-height: 20vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
        margin: 3px 0 12px; padding: 8px; background: #0e191c; border-radius: 7px; font: inherit; }
      form { display: flex; justify-content: end; gap: 8px; }
      button { font: inherit; padding: 5px 10px; border: 1px solid #72948a; border-radius: 7px;
        background: #243a3d; color: inherit; cursor: pointer; }
      button[value="apply"] { background: #a8f2d1; color: #15352f; }
      button:focus-visible { outline: 2px solid #a8f2d1; outline-offset: 3px; }
    `);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = '<dialog dir="rtl" lang="fa" aria-labelledby="title"><h2 id="title">تأیید تغییر متن</h2>' +
      '<p>متن فعلی</p><pre dir="auto"></pre><p>نتیجه</p><pre dir="auto"></pre>' +
      '<form method="dialog"><button value="cancel" autofocus>انصراف</button><button value="apply"></button></form></dialog>';
    const dialog = root.querySelector("dialog");
    const [before, after] = dialog.querySelectorAll("pre");
    before.textContent = text;
    after.textContent = converted;
    dialog.querySelector('[value="apply"]').textContent = editable ? "اعمال تغییر" : "کپی نتیجه";
    dialog.addEventListener("close", () => {
      host.remove();
      previewHost = undefined;
      if (dialog.returnValue === "apply" && active) onConfirm();
    }, { once: true });
    document.body.append(host);
    dialog.showModal();
  }

  async function copyDirected(text) {
    const dir = isRtl(text) ? "rtl" : "ltr";
    const block = document.createElement("div");
    block.dir = dir;
    text.split(/\r?\n/).forEach((line, index) => {
      if (index) block.append(document.createElement("br"));
      block.append(document.createTextNode(line));
    });
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([block.outerHTML], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" })
      })]);
    } catch {
      window.alert("کپی با جهت متن در این صفحه در دسترس نیست.");
    }
  }

  chrome.runtime.onMessage.addListener(message => {
    if (!active) return;
    const target = deepFocus();
    const focused = target?.closest(editor);
    if (message.type === "cycle-editor-direction" || message.type === "insert-zwnj") {
      if (!document.hasFocus() || scope === "reading" || !focused || focused.closest(excluded)) return;
      if (message.type === "cycle-editor-direction") cycleDirection(focused);
      else if (canEditSelection(focused, selectionAt(target), true)) {
        document.execCommand("insertText", false, "\u200c");
      }
      return;
    }
    if (!["copy-direction", "clean-persian", "persian-digits"].includes(message.type)) return;
    const selection = selectionAt(target);
    const liveText = selectedText(focused, selection);
    const text = liveText || message.selectionText;
    if (!text) return;
    if (message.type === "copy-direction") {
      void copyDirected(text);
      return;
    }
    const inputFocused = focused?.matches("textarea, input");
    const converted = message.type === "clean-persian" ? cleanPersian(text) :
      inputFocused ? localizeNumbers(text) : localizeDomSelection(selection, text);
    if (converted === text) {
      window.alert("متن انتخاب‌شده تغییری نیاز ندارد.");
      return;
    }
    const editable = !!liveText && canEditSelection(focused, selection);
    const input = focused?.matches("textarea, input") ? focused : null;
    const offsets = input ? [input.selectionStart, input.selectionEnd] : null;
    const range = !input && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    preview(text, converted, editable, () => {
      if (!editable) {
        void copyDirected(converted);
        return;
      }
      if (!focused.isConnected) return;
      focused.focus({ preventScroll: true });
      if (input) input.setSelectionRange(...offsets);
      else {
        const current = selectionAt(target);
        current.removeAllRanges();
        current.addRange(range);
      }
      if (selectedText(focused, selectionAt(target)) !== text ||
        !document.execCommand("insertText", false, converted)) {
        window.alert("این ویرایشگر جایگزینی متن را نپذیرفت.");
      }
    });
  });

  function onFocus(event) {
    watchShadow(getShadow(event.target));
  }

  function rescan() {
    queue(document.body);
    for (const root of shadowObservers.keys()) queue(root);
  }

  function setEnabled(enabled) {
    if (enabled === active) return;
    active = enabled;
    if (active) {
      scan(document.body);
      discoverShadows(document.body);
      observer.observe(document.body, watchOptions);
      document.addEventListener("focusin", onFocus);
      document.addEventListener("input", onInput, true);
      document.addEventListener("compositionend", onInput, true);
    } else {
      observer.disconnect();
      document.removeEventListener("focusin", onFocus);
      for (const [root, watcher] of shadowObservers) releaseShadow(root, watcher);
      cancelAnimationFrame(frame);
      frame = 0;
      dirty.clear();
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("compositionend", onInput, true);
      clearMarks(document);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[scopeKey]) {
      changedKeys.add(scopeKey);
      scope = changes[scopeKey].newValue ?? "both";
    }
    if (changes[sizeKey]) {
      changedKeys.add(sizeKey);
      size = changes[sizeKey].newValue ?? "default";
    }
    if (changes[spacingKey]) {
      changedKeys.add(spacingKey);
      spacing = changes[spacingKey].newValue ?? "default";
    }
    if (changes[key]) {
      changedKeys.add(key);
      setEnabled(changes[key].newValue === true);
    }
    if (active && (changes[scopeKey] || changes[sizeKey] || changes[spacingKey])) rescan();
  });
  chrome.storage.local.get([key, scopeKey, sizeKey, spacingKey]).then(saved => {
    if (!changedKeys.has(scopeKey)) scope = saved[scopeKey] ?? "both";
    if (!changedKeys.has(sizeKey)) size = saved[sizeKey] ?? "default";
    if (!changedKeys.has(spacingKey)) spacing = saved[spacingKey] ?? "default";
    if (!changedKeys.has(key)) setEnabled(saved[key] === true);
    else if (active) rescan();
  }).catch(error => console.warn("Rastno could not read its settings.", error));
})();
