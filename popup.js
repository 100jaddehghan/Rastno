const toggle = document.querySelector("#toggle");
const state = document.querySelector("#state");
const notice = document.querySelector("#notice");
const host = document.querySelector("#host");
const siteList = document.querySelector("#site-list");
const siteCount = document.querySelector("#site-count");
const sitesEmpty = document.querySelector("#sites-empty");

async function renderSites() {
  const settings = await chrome.storage.local.get(null);
  const urls = enabledSiteUrls(settings).sort();
  const permitted = await Promise.all(urls.map(url => chrome.permissions.contains({ origins: [url + "/*"] })));
  const active = urls.filter((_, index) => permitted[index]);
  siteList.replaceChildren(...active.map(url => {
    const item = document.createElement("li");
    const address = document.createElement("bdi");
    address.dir = "ltr";
    address.textContent = url.replace(/^https:\/\//, "");
    item.append(address);
    return item;
  }));
  siteCount.textContent = new Intl.NumberFormat("fa-IR").format(active.length);
  sitesEmpty.hidden = active.length !== 0;
}

function render(enabled) {
  toggle.setAttribute("aria-checked", String(enabled));
  state.textContent = enabled ? "فعال در این وب‌سایت" : "خاموش در این وب‌سایت";
}

async function setup() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
    state.textContent = "در این صفحه در دسترس نیست";
    return;
  }

  const url = new URL(tab.url);
  host.textContent = url.hostname;
  const { key, script } = await siteRegistration(url);
  const scopeKey = key + ":scope";
  const { id, matches } = script;
  const preferences = [["scope", scopeKey, "both"], ["size", key + ":size", "default"],
    ["spacing", key + ":spacing", "default"]];
  const saved = await chrome.storage.local.get([key, ...preferences.map(([, storageKey]) => storageKey)]);
  let enabled = saved[key] === true && await chrome.permissions.contains({ origins: matches });
  render(enabled);
  toggle.disabled = false;

  for (const [id, storageKey, fallback] of preferences) {
    const control = document.getElementById(id);
    let savedValue = saved[storageKey] ?? fallback;
    control.value = savedValue;
    control.disabled = false;
    control.addEventListener("change", async () => {
      control.disabled = true;
      notice.hidden = true;
      try {
        await chrome.storage.local.set({ [storageKey]: control.value });
        savedValue = control.value;
      } catch {
        control.value = savedValue;
        notice.textContent = "ذخیرهٔ انتخاب ممکن نشد. دوباره امتحان کنید.";
        notice.hidden = false;
      } finally {
        control.disabled = false;
      }
    });
  }

  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    notice.hidden = true;
    try {
      if (enabled) {
        await chrome.storage.local.set({ [key]: false });
        enabled = false;
        const registrations = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
        if (registrations.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
      } else {
        if (!await chrome.permissions.request({ origins: matches })) {
          notice.textContent = "برای فعال‌سازی، دسترسی همین وب‌سایت را تأیید کنید.";
          notice.hidden = false;
          return;
        }
        const registrations = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
        if (!registrations.length) {
          await chrome.scripting.registerContentScripts([script]);
        }
        await chrome.storage.local.set({ [key]: true });
        enabled = true;
        try {
          const target = { tabId: tab.id };
          await chrome.scripting.insertCSS({ target, files: ["rtl.css"] });
          await chrome.scripting.executeScript({ target, files: ["content.js"] });
        } catch {
          notice.textContent = "برای اعمال تنظیم در این زبانه، صفحه را دوباره بارگذاری کنید.";
          notice.hidden = false;
        }
      }
    } catch {
      notice.textContent = "تغییر تنظیم کامل نشد. دوباره امتحان کنید.";
      notice.hidden = false;
    } finally {
      render(enabled);
      toggle.disabled = false;
      void renderSites().catch(showSiteListError);
    }
  });
}

setup().catch(() => { state.textContent = "خواندن تنظیمات ممکن نشد"; });
function showSiteListError() {
  sitesEmpty.textContent = "فهرست سایت‌ها در دسترس نیست.";
  sitesEmpty.hidden = false;
}
renderSites().catch(showSiteListError);

chrome.commands.getAll().then(commands => {
  for (const [name, id] of [["cycle-editor-direction", "shortcut"], ["insert-zwnj", "zwnj"]]) {
    const shortcut = commands.find(command => command.name === name)?.shortcut;
    if (!shortcut) continue;
    document.getElementById(id + "-key").textContent = shortcut;
    document.getElementById(id).hidden = false;
  }
}).catch(() => {});
