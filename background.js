importScripts("site-registration.js");

async function restoreSites() {
  const settings = await chrome.storage.local.get(null);
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const scripts = new Map(registered.map(script => [script.id, script]));
  for (const url of enabledSiteUrls(settings)) {
    const { key, script } = await siteRegistration(url);
    if (!await chrome.permissions.contains({ origins: script.matches })) continue;
    if (!(await chrome.storage.local.get(key))[key]) continue;
    try {
      const existing = scripts.get(script.id);
      if (!existing) await chrome.scripting.registerContentScripts([script]);
      else if (!existing.allFrames || !existing.matchOriginAsFallback || existing.persistAcrossSessions === false) {
        await chrome.scripting.updateContentScripts([script]);
      }
    } catch (error) {
      console.info("Rastno could not restore a site registration.", error.message);
    }
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    try {
      const { welcomeShown } = await chrome.storage.local.get("welcomeShown");
      if (!welcomeShown) {
        await chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
        await chrome.storage.local.set({ welcomeShown: true });
      }
    } catch (error) {
      console.info("Rastno could not open its welcome page.", error.message);
    }
  }
  await new Promise(resolve => chrome.contextMenus.removeAll(resolve));
  for (const [id, title] of [
    ["clean-persian", "راست‌نو · پاک‌سازی متن فارسی"],
    ["persian-digits", "راست‌نو · فارسی کردن اعداد"],
    ["copy-direction", "راست‌نو · کپی با جهت متن"]
  ]) {
    chrome.contextMenus.create({ id, title, contexts: ["selection"], documentUrlPatterns: ["http://*/*", "https://*/*"] });
  }
  await restoreSites();
});

chrome.runtime.onStartup.addListener(restoreSites);

async function sendAction(tab, type, frameId, selectionText) {
  if (tab?.id == null) return;
  try {
    const options = frameId == null ? {} : { frameId };
    await chrome.tabs.sendMessage(tab.id, { type, selectionText }, options);
  } catch (error) {
    if (frameId != null) console.info("Rastno could not reach the selected frame.", error.message);
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  const [activeTab] = tab ? [tab] : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await sendAction(activeTab, command);
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  return sendAction(tab, info.menuItemId, info.frameId ?? 0, info.selectionText);
});
