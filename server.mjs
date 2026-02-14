import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvFileSyncCompatible(content) {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const delimiterIndex = trimmed.indexOf("=");
    if (delimiterIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, delimiterIndex).trim();
    if (!key || process.env[key] !== undefined || /\s/.test(key)) {
      continue;
    }

    let value = trimmed.slice(delimiterIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

async function loadEnvFiles() {
  const files = [".env", ".env.example"];
  for (const file of files) {
    const filePath = path.join(__dirname, file);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      loadEnvFileSyncCompatible(content);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.error(`Failed to load ${file}:`, error.message);
      }
    }
  }
}

await loadEnvFiles();

const PORT = Number(process.env.PORT || 8787);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const X_API_BASE_URL = process.env.X_API_BASE_URL || "https://api.x.com/2";
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || "";

const ACCOUNTS_FILE = path.join(__dirname, "config", "accounts.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const clients = new Set();
const accounts = [];
let lastPollCompletedAt = "";

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function broadcastEvent(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

async function ensureAccountsFile() {
  try {
    await fs.access(ACCOUNTS_FILE);
  } catch {
    await fs.mkdir(path.dirname(ACCOUNTS_FILE), { recursive: true });
    const starter = [
      { name: "BTS", username: "bts_bighit" },
      { name: "Stray Kids", username: "Stray_Kids" },
      { name: "BLACKPINK", username: "BLACKPINK" },
    ];
    await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(starter, null, 2), "utf-8");
  }
}

async function loadAccounts() {
  await ensureAccountsFile();
  const raw = await fs.readFile(ACCOUNTS_FILE, "utf-8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("config/accounts.json must be an array.");
  }

  const seen = new Set();
  accounts.length = 0;

  for (const item of parsed) {
    if (!item || typeof item.name !== "string" || typeof item.username !== "string") {
      continue;
    }

    const username = item.username.trim().replace(/^@/, "");
    if (!username) {
      continue;
    }

    const key = username.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    accounts.push({
      name: item.name.trim() || username,
      username,
      usernameKey: key,
      userId: "",
      recentTweets: [],
      latestTweetId: "",
      latestTweetText: "",
      latestTweetCreatedAt: "",
      latestTweetUrl: "",
      error: "",
      initialized: false,
      lastCheckedAt: "",
    });
  }
}

async function saveAccounts() {
  const serializable = accounts.map((account) => ({
    name: account.name,
    username: account.username,
  }));
  await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(serializable, null, 2), "utf-8");
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

async function resolveUserId(account) {
  const data = await xApiRequest(`/users/by/username/${account.username}`);
  const id = data?.data?.id;
  if (!id) {
    throw new Error("User ID not found.");
  }
  account.userId = id;
}

function toTweetUrl(account, tweetId) {
  return `https://x.com/${account.username}/status/${tweetId}`;
}

function pickBestVideoVariant(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
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

  const displayUrl =
    type === "photo"
      ? directUrl
      : previewImageUrl || directUrl;

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

  const imageRegex = /\.(png|jpe?g|gif|webp)(\?|$)/i;
  const links = [];
  for (const urlItem of urls) {
    const expanded = urlItem?.expanded_url || urlItem?.url || "";
    if (expanded && imageRegex.test(expanded)) {
      links.push(expanded);
    }
  }
  return links;
}

function serializeTweet(account, tweet, mediaByKey) {
  const mediaKeys = tweet?.attachments?.media_keys;
  const media = Array.isArray(mediaKeys)
    ? mediaKeys
        .map((key) => serializeTweetMedia(mediaByKey.get(key)))
        .filter(Boolean)
    : [];

  if (media.length === 0) {
    const entityImageLinks = extractImageLinksFromEntities(tweet);
    for (const link of entityImageLinks) {
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
    url: toTweetUrl(account, tweet.id),
    media,
  };
}

async function fetchRecentTweets(account) {
  const data = await xApiRequest(
    `/users/${account.userId}/tweets?max_results=5&exclude=retweets,replies&tweet.fields=created_at,attachments,entities&expansions=attachments.media_keys&media.fields=media_key,type,url,preview_image_url,variants`
  );
  const list = data?.data;
  if (!Array.isArray(list) || list.length === 0) {
    return [];
  }

  const includeMedia = Array.isArray(data?.includes?.media) ? data.includes.media : [];
  const mediaByKey = new Map();
  for (const media of includeMedia) {
    if (media?.media_key) {
      mediaByKey.set(media.media_key, media);
    }
  }

  return list.map((tweet) => serializeTweet(account, tweet, mediaByKey));
}

function serializeAccount(account) {
  return {
    name: account.name,
    username: account.username,
    recentTweets: account.recentTweets,
    latestTweetId: account.latestTweetId,
    latestTweetText: account.latestTweetText,
    latestTweetCreatedAt: account.latestTweetCreatedAt,
    latestTweetUrl: account.latestTweetUrl,
    error: account.error,
    lastCheckedAt: account.lastCheckedAt,
  };
}

async function refreshOneAccount(account) {
  account.error = "";
  account.lastCheckedAt = new Date().toISOString();

  if (!X_BEARER_TOKEN) {
    account.error = "X_BEARER_TOKEN 환경 변수가 설정되지 않았습니다.";
    return;
  }

  try {
    if (!account.userId) {
      await resolveUserId(account);
    }

    const recentTweets = await fetchRecentTweets(account);
    const newest = recentTweets[0] || null;
    const wasInitialized = account.initialized;
    const previousLatestTweetId = account.latestTweetId;

    account.recentTweets = recentTweets;
    account.latestTweetId = newest?.id || "";
    account.latestTweetText = newest?.text || "";
    account.latestTweetCreatedAt = newest?.createdAt || "";
    account.latestTweetUrl = newest?.url || "";
    account.initialized = true;

    if (wasInitialized && previousLatestTweetId && newest && previousLatestTweetId !== newest.id) {
      broadcastEvent("new_post", {
        account: serializeAccount(account),
        detectedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    account.error = error instanceof Error ? error.message : String(error);
  }
}

async function pollAccounts() {
  await Promise.allSettled(accounts.map((account) => refreshOneAccount(account)));
  lastPollCompletedAt = new Date().toISOString();
  broadcastEvent("state", {
    serverTime: lastPollCompletedAt,
    pollIntervalMs: POLL_INTERVAL_MS,
    lastPollCompletedAt,
    accounts: accounts.map(serializeAccount),
  });
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("\n");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStaticFile(res, filePath) {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const typeByExt = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    };

    res.writeHead(200, {
      "Content-Type": typeByExt[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function handleAddAccount(req, res) {
  try {
    const body = await readBody(req);
    const name = String(body?.name || "").trim();
    const usernameRaw = String(body?.username || "").trim();
    const username = usernameRaw.replace(/^@/, "");
    const usernameKey = username.toLowerCase();

    if (!name || !username) {
      jsonResponse(res, 400, { error: "name, username 값이 필요합니다." });
      return;
    }

    if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
      jsonResponse(res, 400, { error: "username 형식이 올바르지 않습니다." });
      return;
    }

    if (accounts.some((account) => account.usernameKey === usernameKey)) {
      jsonResponse(res, 409, { error: "이미 등록된 계정입니다." });
      return;
    }

    const newAccount = {
      name,
      username,
      usernameKey,
      userId: "",
      recentTweets: [],
      latestTweetId: "",
      latestTweetText: "",
      latestTweetCreatedAt: "",
      latestTweetUrl: "",
      error: "",
      initialized: false,
      lastCheckedAt: "",
    };

    accounts.push(newAccount);
    await saveAccounts();
    await refreshOneAccount(newAccount);

    jsonResponse(res, 201, { account: serializeAccount(newAccount) });
    broadcastEvent("state", {
      serverTime: new Date().toISOString(),
      pollIntervalMs: POLL_INTERVAL_MS,
      lastPollCompletedAt,
      accounts: accounts.map(serializeAccount),
    });
  } catch (error) {
    jsonResponse(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && reqUrl.pathname === "/") {
    await serveStaticFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/state") {
    jsonResponse(res, 200, {
      tokenConfigured: Boolean(X_BEARER_TOKEN),
      canPersistAccounts: true,
      supportsRealtimeSse: true,
      pollIntervalMs: POLL_INTERVAL_MS,
      serverTime: new Date().toISOString(),
      lastPollCompletedAt,
      accounts: accounts.map(serializeAccount),
    });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/accounts") {
    await handleAddAccount(req, res);
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/events") {
    sendSseHeaders(res);
    clients.add(res);

    res.write(
      `event: connected\ndata: ${JSON.stringify({
        connectedAt: new Date().toISOString(),
      })}\n\n`
    );

    req.on("close", () => {
      clients.delete(res);
      res.end();
    });
    return;
  }

  if (req.method === "GET") {
    const candidate = path.normalize(path.join(PUBLIC_DIR, reqUrl.pathname));
    if (candidate.startsWith(PUBLIC_DIR)) {
      await serveStaticFile(res, candidate);
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

async function start() {
  await loadAccounts();
  await pollAccounts();

  setInterval(() => {
    pollAccounts().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      broadcastEvent("error", {
        message,
        occurredAt: new Date().toISOString(),
      });
    });
  }, POLL_INTERVAL_MS);

  server.listen(PORT, () => {
    const tokenStatus = X_BEARER_TOKEN ? "configured" : "missing";
    console.log(`X watcher running on http://localhost:${PORT}`);
    console.log(`X_BEARER_TOKEN: ${tokenStatus}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
