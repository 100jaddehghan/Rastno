async function siteRegistration(url) {
  const site = new URL(url);
  const key = "rastno:" + site.protocol + "//" + site.hostname;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return {
    key,
    script: {
      id: "site-" + hash,
      matches: [site.protocol + "//" + site.hostname + "/*"],
      js: ["content.js"],
      css: ["rtl.css"],
      runAt: "document_idle",
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true
    }
  };
}

function enabledSiteUrls(settings) {
  return Object.entries(settings)
    .filter(([key, value]) => value === true && /^rastno:https?:\/\/[^/]+$/.test(key))
    .map(([key]) => key.slice("rastno:".length));
}
