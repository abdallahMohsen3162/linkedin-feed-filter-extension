const loginPage = document.getElementById("loginPage");
const dashboardPage = document.getElementById("dashboardPage");

const googleLoginBtn = document.getElementById("googleLoginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const loginError = document.getElementById("loginError");
const settingsError = document.getElementById("settingsError");

const userAvatar = document.getElementById("userAvatar");
const userAvatarFallback = document.getElementById("userAvatarFallback");
const userName = document.getElementById("userName");
const userEmail = document.getElementById("userEmail");

const hideNonHiringPosts = document.getElementById("hideNonHiringPosts");
const collapseNonHiringPosts = document.getElementById("collapseNonHiringPosts");
const showAllPosts = document.getElementById("showAllPosts");

const feedToggles = [
  { el: hideNonHiringPosts, key: "hideNonHiringPosts" },
  { el: collapseNonHiringPosts, key: "collapseNonHiringPosts" },
  { el: showAllPosts, key: "showAllPosts" },
];

let sessionToken = null;
let settingsSyncInProgress = false;
let currentFeedSettings = {
  hideNonHiringPosts: false,
  collapseNonHiringPosts: false,
  showAllPosts: true,
};

function showDashboard(user) {
  loginPage.classList.add("hidden");
  dashboardPage.classList.remove("hidden");
  hideLoginError();
  hideSettingsError();
  renderUser(user);
  applyFeedSettingsToUI(user?.feedSettings);
}

function showLogin() {
  dashboardPage.classList.add("hidden");
  loginPage.classList.remove("hidden");
  renderUser(null);
}

function renderUser(user) {
  const displayName = user?.name || user?.email || "";
  userName.textContent = displayName;
  userEmail.textContent = user?.email ?? "";

  const showFallback = () => {
    userAvatar.removeAttribute("src");
    userAvatar.classList.add("hidden");
    userAvatarFallback.textContent = (displayName[0] || "?").toUpperCase();
    userAvatarFallback.classList.remove("hidden");
  };

  userAvatar.onerror = showFallback;

  if (user?.picture) {
    userAvatar.src = user.picture;
    userAvatar.alt = displayName ? `${displayName}'s profile photo` : "Profile photo";
    userAvatar.classList.remove("hidden");
    userAvatarFallback.classList.add("hidden");
  } else {
    showFallback();
  }
}

function applyFeedSettingsToUI(feedSettings = {}) {
  currentFeedSettings = {
    hideNonHiringPosts: feedSettings.hideNonHiringPosts ?? false,
    collapseNonHiringPosts: feedSettings.collapseNonHiringPosts ?? false,
    showAllPosts: feedSettings.showAllPosts ?? true,
  };

  hideNonHiringPosts.checked = currentFeedSettings.hideNonHiringPosts;
  collapseNonHiringPosts.checked = currentFeedSettings.collapseNonHiringPosts;
  showAllPosts.checked = currentFeedSettings.showAllPosts;
}

function showLoginError(message) {
  loginError.textContent = message;
  loginError.classList.remove("hidden");
}

function hideLoginError() {
  loginError.textContent = "";
  loginError.classList.add("hidden");
}

function showSettingsError(message) {
  settingsError.textContent = message;
  settingsError.classList.remove("hidden");
}

function hideSettingsError() {
  settingsError.textContent = "";
  settingsError.classList.add("hidden");
}

function parseApiError(data, fallback) {
  const message = Array.isArray(data.message) ? data.message.join(", ") : data.message;
  return message || fallback;
}

function getGoogleAccessToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!token) {
        reject(new Error("Google sign-in was cancelled"));
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedGoogleToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function exchangeGoogleTokenForSession(googleAccessToken) {
  const response = await fetch(`${API_BASE_URL}/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: googleAccessToken }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(parseApiError(data, "Backend login failed"));
  }

  return data;
}

async function validateSession(accessToken) {
  const response = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(parseApiError(data, "Session expired"));
  }

  return data;
}

async function updateFeedSettingsOnServer(accessToken, feedSettings) {
  const response = await fetch(`${API_BASE_URL}/auth/feed-settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(feedSettings),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(parseApiError(data, "Could not save settings"));
  }

  return data;
}

async function syncFeedSettingsToStorage(feedSettings) {
  await chrome.storage.local.set({ feedSettings });
}

async function persistUserState(user, accessToken) {
  sessionToken = accessToken;
  await chrome.storage.local.set({
    loggedIn: true,
    accessToken,
    user,
    feedSettings: user.feedSettings,
  });
  await syncFeedSettingsToStorage(user.feedSettings);
}

async function restoreSession() {
  const stored = await chrome.storage.local.get(["accessToken", "user"]);
  sessionToken = stored.accessToken ?? null;

  if (!sessionToken) {
    showLogin();
    return;
  }

  try {
    const profile = await validateSession(sessionToken);
    await persistUserState(profile, sessionToken);
    showDashboard(profile);
  } catch {
    await chrome.storage.local.remove(["accessToken", "user", "loggedIn", "feedSettings"]);
    sessionToken = null;
    showLogin();
  }
}

googleLoginBtn.addEventListener("click", async () => {
  hideLoginError();
  googleLoginBtn.disabled = true;

  let googleToken;

  try {
    googleToken = await getGoogleAccessToken(true);
    const session = await exchangeGoogleTokenForSession(googleToken);
    await persistUserState(session.user, session.accessToken);
    showDashboard(session.user);
  } catch (error) {
    if (googleToken) {
      await removeCachedGoogleToken(googleToken);
    }
    showLoginError(error.message || "Could not sign in with Google");
  } finally {
    googleLoginBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  logoutBtn.disabled = true;

  try {
    const googleToken = await getGoogleAccessToken(false).catch(() => null);
    if (googleToken) {
      await removeCachedGoogleToken(googleToken);
    }
  } finally {
    await chrome.storage.local.remove([
      "accessToken",
      "user",
      "loggedIn",
      "feedSettings",
    ]);
    sessionToken = null;
    logoutBtn.disabled = false;
    showLogin();
  }
});

feedToggles.forEach(({ el, key }) => {
  el.addEventListener("change", async () => {
    if (settingsSyncInProgress || !sessionToken) return;

    const snapshot = { ...currentFeedSettings };
    const payload = { [key]: el.checked };

    settingsSyncInProgress = true;
    hideSettingsError();
    feedToggles.forEach(({ el: toggle }) => {
      toggle.disabled = true;
    });

    try {
      const updatedUser = await updateFeedSettingsOnServer(sessionToken, payload);
      applyFeedSettingsToUI(updatedUser.feedSettings);
      await persistUserState(updatedUser, sessionToken);
    } catch (error) {
      applyFeedSettingsToUI(snapshot);
      showSettingsError(error.message || "Could not save settings");
    } finally {
      settingsSyncInProgress = false;
      feedToggles.forEach(({ el: toggle }) => {
        toggle.disabled = false;
      });
    }
  });
});

restoreSession();
