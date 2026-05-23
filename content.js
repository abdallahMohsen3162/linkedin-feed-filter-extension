const DEFAULT_FEED_SETTINGS = {
  hideNonHiringPosts: false,
  collapseNonHiringPosts: false,
  showAllPosts: true,
};

let feedSettings = { ...DEFAULT_FEED_SETTINGS };
const originalPostNodes = new WeakMap();
const postActionCache = new WeakMap();
let getPostsTimer = null;
let getPostsRunning = false;
let feedObserver = null;

async function isHiringPost(postData) {
  const { accessToken } = await chrome.storage.local.get("accessToken");
  if (!accessToken) return true;

  const response = await fetch(`${API_BASE_URL}/posts/is-hiring`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ text: postData.text }),
  });

  if (!response.ok) return true;

  const { isHiring } = await response.json();
  return isHiring;
}

async function fetchFeedSettingsFromBackend(accessToken) {
  const response = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) throw new Error("Failed to load settings from backend");

  const profile = await response.json();
  return profile.feedSettings ?? DEFAULT_FEED_SETTINGS;
}

function applyFeedSettings(settings) {
  feedSettings = { ...DEFAULT_FEED_SETTINGS, ...settings };
}

async function loadFeedSettings() {
  const { accessToken, feedSettings: cached } = await chrome.storage.local.get([
    "accessToken",
    "feedSettings",
  ]);

  const cachedSettings = { ...DEFAULT_FEED_SETTINGS, ...(cached ?? {}) };

  if (!accessToken) {
    applyFeedSettings(cachedSettings);
    scheduleGetPosts();
    return;
  }

  try {
    const fromBackend = await fetchFeedSettingsFromBackend(accessToken);
    applyFeedSettings(fromBackend);
    await chrome.storage.local.set({ feedSettings: fromBackend });
  } catch (e) {
    applyFeedSettings(cachedSettings);
  }

  scheduleGetPosts();
}

function saveOriginalNodes(postContainer) {
  if (originalPostNodes.has(postContainer)) return;
  const nodes = Array.from(postContainer.childNodes);
  originalPostNodes.set(postContainer, nodes);
}

function hideOriginalNodes(postContainer) {
  const nodes = originalPostNodes.get(postContainer);
  if (!nodes) return;
  nodes.forEach((node) => {
    if (node.nodeType === 1) node.style.display = "none";
  });
}

function showOriginalNodes(postContainer) {
  const nodes = originalPostNodes.get(postContainer);
  if (!nodes) return;
  nodes.forEach((node) => {
    if (node.nodeType === 1) node.style.display = "";
  });
}

function getPlaceholder(postContainer) {
  return postContainer.querySelector(".linkedin-reader-injected");
}

function removePlaceholder(postContainer) {
  const placeholder = getPlaceholder(postContainer);
  if (placeholder) placeholder.remove();
}

function restoreOriginalPost(postContainer, userExpanded = false) {
  removePlaceholder(postContainer);
  showOriginalNodes(postContainer);

  if (userExpanded) {
    postContainer.dataset.linkedinReaderState = "user-expanded";
  } else {
    delete postContainer.dataset.linkedinReaderState;
  }
}

function renderLoadingPost(postContainer) {
  saveOriginalNodes(postContainer);
  hideOriginalNodes(postContainer);
  removePlaceholder(postContainer);

  postContainer.dataset.linkedinReaderState = "loading";

  const placeholder = document.createElement("div");
  placeholder.className =
    "linkedin-reader-injected linkedin-reader-placeholder linkedin-reader-loading";
  placeholder.innerHTML = `
    <div class="linkedin-reader-progress-bar">
      <div class="linkedin-reader-progress-fill"></div>
    </div>
  `;
  postContainer.appendChild(placeholder);
}

function renderHiddenPost(postContainer) {
  saveOriginalNodes(postContainer);
  hideOriginalNodes(postContainer);
  removePlaceholder(postContainer);

  postContainer.dataset.linkedinReaderState = "hidden";

  const wrapper = document.createElement("div");
  wrapper.className =
    "linkedin-reader-injected linkedin-reader-placeholder linkedin-reader-hidden";

  const span = document.createElement("span");
  span.textContent = "🚫 Non-hiring post hidden";

  wrapper.appendChild(span);
  postContainer.appendChild(wrapper);
}

function renderCollapsedPost(postContainer, postData) {
  saveOriginalNodes(postContainer);
  hideOriginalNodes(postContainer);
  removePlaceholder(postContainer);

  postContainer.dataset.linkedinReaderState = "collapsed";

  const wrapper = document.createElement("div");
  wrapper.className =
    "linkedin-reader-injected linkedin-reader-placeholder linkedin-reader-collapsed";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "linkedin-reader-expand-btn";
  button.textContent = `Post from ${postData.author}`;
  button.addEventListener("click", () => restoreOriginalPost(postContainer, true));

  wrapper.appendChild(button);
  postContainer.appendChild(wrapper);
}

function resetPostContainer(postContainer) {
  const state = postContainer.dataset.linkedinReaderState;
  if (state && state !== "user-expanded") {
    restoreOriginalPost(postContainer);
  }
}

function applyAction(postContainer, postData, action) {
  if (action === "hidden") {
    renderHiddenPost(postContainer);
  } else if (action === "collapsed") {
    renderCollapsedPost(postContainer, postData);
  } else {
    resetPostContainer(postContainer);
  }
}


function extractPostData(postContainer, index) {
  const hasActions =
    postContainer.querySelector('[id="repost-small"]') ||
    postContainer.querySelector('[aria-label*="Reaction button"]');
  if (!hasActions) return null;

  const author =
    postContainer.querySelector('a[href*="/in/"] strong')?.innerText?.trim() ||
    postContainer.querySelector('a[href*="/in/"] span[class*="fa649af6"]')?.innerText?.trim() ||
    postContainer
      .querySelector('a[href*="/in/"] [aria-label*="View"] ~ div p span')
      ?.innerText?.trim() ||
    postContainer
      .querySelector('figure img[alt*="View"]')
      ?.alt?.replace("View ", "")
      ?.replace("'s profile", "")
      ?.trim() ||
    "Unknown";

  const commentSection = postContainer.querySelector('[data-testid*="commentList"]');
  const allTextBoxes = postContainer.querySelectorAll('[data-testid="expandable-text-box"]');
  const postTextBox = [...allTextBoxes].find((box) => !commentSection?.contains(box));

  const clone = postTextBox?.cloneNode(true);
  clone?.querySelectorAll("button").forEach((b) => b.remove());
  const text = clone?.innerText?.trim() || "";

  const images = [...postContainer.querySelectorAll("img")]
    .map((img) => img.src)
    .filter(
      (src) =>
        src &&
        !src.includes("profile-displayphoto") &&
        !src.includes("company-logo")
    );

  const hasVideo = !!postContainer.querySelector("video");


  if (!text && images.length === 0 && !hasVideo) return null;

  return { index, author, text, images, hasVideo };
}

function isPostComplete(postContainer) {
  const hasActions =
    postContainer.querySelector('[id="repost-small"]') ||
    postContainer.querySelector('[aria-label*="Reaction button"]');


  return !!hasActions;
}


async function resolvePostAction(postContainer, postData) {
  if (postActionCache.has(postContainer)) {
    return postActionCache.get(postContainer);
  }

  if (feedSettings.showAllPosts) {
    postActionCache.set(postContainer, "visible");
    return "visible";
  }


  if (!postData.text) {
    let action = "visible";
    if (feedSettings.hideNonHiringPosts) action = "hidden";
    else if (feedSettings.collapseNonHiringPosts) action = "collapsed";
    postActionCache.set(postContainer, action);
    return action;
  }

  const hiring = await isHiringPost(postData);
  let action = "visible";
  if (!hiring) {
    if (feedSettings.hideNonHiringPosts) action = "hidden";
    else if (feedSettings.collapseNonHiringPosts) action = "collapsed";
  }

  postActionCache.set(postContainer, action);
  return action;
}


function immediatelyLoadNewPosts(mutations) {
  if (feedSettings.showAllPosts) return;

  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;

      const candidates = [];
      if (node.matches?.('[role="listitem"]')) candidates.push(node);
      node.querySelectorAll?.('[role="listitem"]').forEach((el) => candidates.push(el));

      for (const candidate of candidates) {
        const state = candidate.dataset.linkedinReaderState;
        if (state) continue;

        if (!isPostComplete(candidate)) {

          candidate.style.visibility = "hidden";
          candidate.style.minHeight = "0";
          candidate.style.overflow = "hidden";
          candidate.dataset.linkedinReaderState = "pending";
          continue;
        }


        candidate.style.visibility = "";
        candidate.style.minHeight = "";
        candidate.style.overflow = "";

        if (postActionCache.has(candidate)) {
          const postData = extractPostData(candidate, 0);
          if (postData) applyAction(candidate, postData, postActionCache.get(candidate));
          continue;
        }

        const postData = extractPostData(candidate, 0);
        if (postData) {
          renderLoadingPost(candidate);
        } else {

          candidate.style.visibility = "";
          candidate.style.minHeight = "";
          candidate.style.overflow = "";
        }
      }
    }


    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;

      const candidates = [];
      if (node.matches?.('[role="listitem"]')) candidates.push(node);
      node.querySelectorAll?.('[role="listitem"]').forEach((el) => candidates.push(el));

      for (const candidate of candidates) {
        if (candidate.dataset.linkedinReaderState !== "pending") continue;
        if (!isPostComplete(candidate)) continue;


        candidate.style.visibility = "";
        candidate.style.minHeight = "";
        candidate.style.overflow = "";

        if (postActionCache.has(candidate)) {
          const postData = extractPostData(candidate, 0);
          if (postData) applyAction(candidate, postData, postActionCache.get(candidate));
          continue;
        }

        const postData = extractPostData(candidate, 0);
        if (postData) {
          renderLoadingPost(candidate);
        }
      }
    }
  }
}


function checkPendingPosts() {
  if (feedSettings.showAllPosts) return;

  const pending = document.querySelectorAll('[data-linkedin-reader-state="pending"]');
  for (const candidate of pending) {
    if (!isPostComplete(candidate)) continue;

    candidate.style.visibility = "";
    candidate.style.minHeight = "";
    candidate.style.overflow = "";

    if (postActionCache.has(candidate)) {
      const postData = extractPostData(candidate, 0);
      if (postData) applyAction(candidate, postData, postActionCache.get(candidate));
      continue;
    }

    const postData = extractPostData(candidate, 0);
    if (postData) renderLoadingPost(candidate);
  }
}

async function getPosts() {
  if (getPostsRunning) return [];
  getPostsRunning = true;

  if (feedObserver) feedObserver.disconnect();

  const postItems = document.querySelectorAll('[role="listitem"]');
  const data = [];

  try {
    if (feedSettings.showAllPosts) {
      for (const postContainer of postItems) {

        postContainer.style.visibility = "";
        postContainer.style.minHeight = "";
        postContainer.style.overflow = "";

        const state = postContainer.dataset.linkedinReaderState;
        if (state && state !== "user-expanded") restoreOriginalPost(postContainer);
        const postData = extractPostData(postContainer, data.length);
        if (postData) data.push(postData);
      }
      return data;
    }

    const queue = [];

    for (const postContainer of postItems) {
      const state = postContainer.dataset.linkedinReaderState;

      if (state === "user-expanded") continue;
      if (state === "collapsed") continue;
      if (state === "hidden") continue;


      if (state === "pending") {
        if (!isPostComplete(postContainer)) continue;
        postContainer.style.visibility = "";
        postContainer.style.minHeight = "";
        postContainer.style.overflow = "";
        delete postContainer.dataset.linkedinReaderState;
      }

      const postData = extractPostData(postContainer, queue.length);
      if (!postData) {

        postContainer.style.visibility = "";
        postContainer.style.minHeight = "";
        postContainer.style.overflow = "";
        continue;
      }

      if (postActionCache.has(postContainer)) {
        const action = postActionCache.get(postContainer);
        if (action === "visible") {
          if (state === "loading") resetPostContainer(postContainer);
          data.push(postData);
        } else {
          applyAction(postContainer, postData, action);
        }
        continue;
      }

      if (state !== "loading") {
        if (!isPostComplete(postContainer)) continue;
        renderLoadingPost(postContainer);
      }

      queue.push({ postContainer, postData });
    }

    for (const { postContainer, postData } of queue) {
      if (postContainer.dataset.linkedinReaderState === "user-expanded") continue;

      const action = await resolvePostAction(postContainer, postData);

      if (action === "visible") data.push(postData);
      applyAction(postContainer, postData, action);
    }
  } finally {
    getPostsRunning = false;
    if (feedObserver) {
      feedObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  return data;
}

function scheduleGetPosts() {
  clearTimeout(getPostsTimer);
  getPostsTimer = setTimeout(() => getPosts(), 300);
}

function injectStyles() {
  if (document.getElementById("linkedin-reader-styles")) return;

  const style = document.createElement("style");
  style.id = "linkedin-reader-styles";
  style.textContent = `
    .linkedin-reader-placeholder {
      padding: 12px 16px;
      margin: 8px 0;
      border: 1px dashed #ccc;
      border-radius: 8px;
      font-size: 14px;
    }
    .linkedin-reader-hidden {
      color: #999;
      text-align: center;
      min-height: 60px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      flex-direction: column;
    }
    .linkedin-reader-show-btn {
      padding: 6px 12px;
      border: 1px solid #ccc;
      border-radius: 6px;
      background: #fff;
      color: #555;
      font-size: 12px;
      cursor: pointer;
    }
    .linkedin-reader-show-btn:hover {
      background: #f3f3f3;
    }
    .linkedin-reader-loading {
      border-color: #0a66c2;
      padding: 16px;
    }
    .linkedin-reader-progress-bar {
      height: 3px;
      background: #e0e0e0;
      border-radius: 2px;
      overflow: hidden;
      width: 100%;
    }
    .linkedin-reader-progress-fill {
      height: 100%;
      width: 30%;
      background: #0a66c2;
      border-radius: 2px;
      animation: linkedin-reader-slide 1s infinite ease-in-out;
    }
    @keyframes linkedin-reader-slide {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(400%); }
    }
    .linkedin-reader-expand-btn {
      padding: 8px 14px;
      border: none;
      border-radius: 8px;
      background: #0a66c2;
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .linkedin-reader-expand-btn:hover {
      background: #004182;
    }
  `;
  document.head.appendChild(style);
}

function waitForFeed(callback) {
  const observer = new MutationObserver((_, obs) => {
    const feed = document.querySelector('[data-testid="expandable-text-box"]');
    if (feed) {
      obs.disconnect();
      callback();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.feedSettings) {
    applyFeedSettings(changes.feedSettings.newValue);
    document.querySelectorAll('[role="listitem"]').forEach((el) => {
      postActionCache.delete(el);

      el.style.visibility = "";
      el.style.minHeight = "";
      el.style.overflow = "";
      const state = el.dataset.linkedinReaderState;
      if (state && state !== "user-expanded") restoreOriginalPost(el);
    });
    scheduleGetPosts();
    return;
  }

  if (changes.accessToken?.newValue) loadFeedSettings();
});

waitForFeed(() => {
  injectStyles();
  loadFeedSettings();
  feedObserver = new MutationObserver((mutations) => {
    immediatelyLoadNewPosts(mutations);
    checkPendingPosts();
    scheduleGetPosts();
  });
  feedObserver.observe(document.body, { childList: true, subtree: true });
});