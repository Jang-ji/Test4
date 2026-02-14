import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ACCOUNTS_FILE = path.join(__dirname, "..", "config", "accounts.json");
const X_API_BASE_URL = process.env.X_API_BASE_URL || "https://api.x.com/2";
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || "";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);

const userIdCache = globalThis.__xUserIdCache || new Map();
globalThis.__xUserIdCache = userIdCache;

function toTweetUrl(username, tweetId) {
  return `https://x.com/${username}/status/${tweetId}`;
}

function pickBestVideoVariant(variants) {
  if (!Array.isArray(variants)) {
    return "";
  }

  const mp4Only = variants.filter((item) => item && item.content_type === "video/mp4" && item.url);
  if (mp4Only.length === 0) {
    return "";
  }

  mp4Only.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4Only[0].url || "";
}

function serializeTweetMedia(media) {
  if (!media) {
    return null;
  }

  const type = media.type || "";
  const directUrl = media.url || "";
  const previewImageUrl = media.preview_image_url || "";
  const videoUrl = pickBestVideoVariant(media.variants);

  const displayUrl = type === "photo" ? directUrl : previewImageUrl || directUrl;
  if (!displayUrl) {
    return null;
  }

  return {
    type,
    displayUrl,
    openUrl: directUrl || videoUrl || displayUrl,
  };
}

function extractImageLinksFromEntities(tweet) {
  const urls = tweet?.entities?.urls;
  if (!Array.isArray(urls)) {
    return [];
  }

  const links = [];
  const imageRegex = /\.(png|jpe?g|gif|webp)(\?|$)/i;
  for (const urlItem of urls) {
    const expanded = urlItem?.expanded_url || urlItem?.url || "";
    if (expanded && imageRegex.test(expanded)) {
      links.push(expanded);
    }
  }
  return links;
}

function serializeTweet(username, tweet, mediaByKey) {
  const mediaKeys = tweet?.attachments?.media_keys;
  const media = Array.isArray(mediaKeys)
    ? mediaKeys
        .map((key) => serializeTweetMedia(mediaByKey.get(key)))
        .filter(Boolean)
    : [];

  if (media.length === 0) {
    for (const link of extractImageLinksFromEntities(tweet)) {
      media.push({
        type: "external_image",
        displayUrl: link,
        openUrl: link,
      });
    }
  }

  return {
    id: tweet.id,
    text: tweet.text || "",
    createdAt: tweet.created_at || "",
    url: toTweetUrl(username, tweet.id),
    media,
  };
}

async function xApiRequest(endpoint) {
  const response = await fetch(`${X_API_BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${X_BEARER_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const detail = data?.detail || data?.title || response.statusText;
    throw new Error(`X API error (${response.status}): ${detail}`);
  }

  return data;
}

async function loadAccounts() {
  const raw = await fs.readFile(ACCOUNTS_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("config/accounts.json must be an array.");
  }

  const seen = new Set();
  const accounts = [];

  for (const item of parsed) {
    if (!item || typeof item.name !== "string" || typeof item.username !== "string") {
      continue;
    }

    const username = item.username.trim().replace(/^@/, "");
    if (!username) {
      continue;
    }

    const usernameKey = username.toLowerCase();
    if (seen.has(usernameKey)) {
      continue;
    }
    seen.add(usernameKey);

    accounts.push({
      name: item.name.trim() || username,
      username,
    });
  }

  return accounts;
}

async function resolveUserId(username) {
  const cacheKey = username.toLowerCase();
  if (userIdCache.has(cacheKey)) {
    return userIdCache.get(cacheKey);
  }

  const data = await xApiRequest(`/users/by/username/${username}`);
  const userId = data?.data?.id;
  if (!userId) {
    throw new Error("User ID not found.");
  }

  userIdCache.set(cacheKey, userId);
  return userId;
}

async function fetchRecentTweets(username, userId) {
  const data = await xApiRequest(
    `/users/${userId}/tweets?max_results=5&exclude=retweets,replies&tweet.fields=created_at,attachments,entities&expansions=attachments.media_keys&media.fields=media_key,type,url,preview_image_url,variants`
  );

  const tweets = Array.isArray(data?.data) ? data.data : [];
  const mediaList = Array.isArray(data?.includes?.media) ? data.includes.media : [];
  const mediaByKey = new Map();

  for (const media of mediaList) {
    if (media?.media_key) {
      mediaByKey.set(media.media_key, media);
    }
  }

  return tweets.map((tweet) => serializeTweet(username, tweet, mediaByKey));
}

async function buildState() {
  const accounts = await loadAccounts();
  const nowIso = new Date().toISOString();

  const accountStates = await Promise.all(
    accounts.map(async (account) => {
      const output = {
        name: account.name,
        username: account.username,
        recentTweets: [],
        latestTweetId: "",
        latestTweetText: "",
        latestTweetCreatedAt: "",
        latestTweetUrl: "",
        error: "",
        lastCheckedAt: nowIso,
      };

      if (!X_BEARER_TOKEN) {
        output.error = "X_BEARER_TOKEN 환경 변수가 설정되지 않았습니다.";
        return output;
      }

      try {
        const userId = await resolveUserId(account.username);
        const recentTweets = await fetchRecentTweets(account.username, userId);
        const newest = recentTweets[0] || null;

        output.recentTweets = recentTweets;
        output.latestTweetId = newest?.id || "";
        output.latestTweetText = newest?.text || "";
        output.latestTweetCreatedAt = newest?.createdAt || "";
        output.latestTweetUrl = newest?.url || "";
      } catch (error) {
        output.error = error instanceof Error ? error.message : String(error);
      }

      return output;
    })
  );

  return {
    tokenConfigured: Boolean(X_BEARER_TOKEN),
    canPersistAccounts: false,
    supportsRealtimeSse: false,
    pollIntervalMs: POLL_INTERVAL_MS,
    serverTime: nowIso,
    accounts: accountStates,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const payload = await buildState();
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.status(200).json(payload);
  } catch (error) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
