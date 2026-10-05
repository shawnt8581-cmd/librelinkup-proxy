import express from "express";
import cors from "cors";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

const app = express();
app.use(cors());
app.use(express.raw({ type: "*/*" }));

// Resolve hostname via DNS-over-HTTPS (bypasses broken system DNS)
async function resolveViaDoH(hostname) {
  const dohUrls = [
    `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    `https://8.8.8.8/resolve?name=${encodeURIComponent(hostname)}&type=A`,
    `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
  ];

  for (const dohUrl of dohUrls) {
    try {
      const res = await fetch(dohUrl, {
        headers: { Accept: "application/dns-json" },
      });
      const data = await res.json();

      if (data.Answer) {
        // Look for A records (type 1)
        const aRecords = data.Answer.filter((r) => r.type === 1);
        if (aRecords.length > 0) {
          return aRecords[0].data;
        }

        // Follow CNAME (type 5)
        const cname = data.Answer.find((r) => r.type === 5);
        if (cname) {
          const target = cname.data.replace(/\.$/, "");
          return await resolveViaDoH(target);
        }
      }
    } catch (e) {
      console.error(`DoH failed for ${dohUrl}:`, e.message);
    }
  }

  throw new Error(`Could not resolve ${hostname} via DoH`);
}

function makeRequest(targetUrl, method, headers, body, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: { ...headers, host: parsed.hostname },
      servername: parsed.hostname,
    };

    const req = lib.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 5) {
        const redirectUrl = new URL(res.headers.location, targetUrl).href;
        makeRequest(redirectUrl, method, headers, body, redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timeout"));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function makeRequestWithDoH(targetUrl, method, headers, body) {
  const parsed = new URL(targetUrl);
  const ip = await resolveViaDoH(parsed.hostname);

  console.log(`Resolved ${parsed.hostname} to ${ip}`);

  // Connect to the IP directly, but use the real hostname for SNI and Host header
  const isHttps = parsed.protocol === "https:";
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: ip,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: { ...headers, host: parsed.hostname },
      servername: parsed.hostname,
      rejectUnauthorized: true,
    };

    const req = lib.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).href;
        makeRequestWithDoH(redirectUrl, method, headers, body).then(resolve).catch(reject);
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timeout"));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

const BASE_URLS = {
  us: "https://api2-us.libreview.io",
  eu: "https://api2-eu.libreview.io",
  de: "https://api2-de.libreview.io",
  fr: "https://api2-fr.libreview.io",
  jp: "https://api2-jp.libreview.io",
  ap: "https://api2-ap.libreview.io",
  ca: "https://api2-ca.libreview.io",
  ae: "https://api2-ae.libreview.io",
  au: "https://api2-au.libreview.io",
};

app.options("*", (req, res) => res.sendStatus(204));

app.all("*", async (req, res) => {
  let targetUrl = null;

  if (req.query.url) {
    targetUrl = req.query.url;
  }

  if (!targetUrl) {
    const path = req.path.substring(1);
    if (path.startsWith("http://") || path.startsWith("https://")) {
      targetUrl = decodeURIComponent(path);
    }
  }

  if (!targetUrl) {
    const region = req.query.region || "us";
    const base = BASE_URLS[region] || BASE_URLS.us;
    targetUrl = base + req.path;
    const u = new URL(targetUrl);
    Object.entries(req.query).forEach(([k, v]) => {
      if (k !== "region") u.searchParams.append(k, v);
    });
    targetUrl = u.href;
  }

  const forwardHeaders = { ...req.headers };
  delete forwardHeaders.host;
  delete forwardHeaders.origin;
  delete forwardHeaders.referer;
  delete forwardHeaders["x-forwarded-for"];
  delete forwardHeaders["x-real-ip"];
  delete forwardHeaders["cdn-loop"];
  delete forwardHeaders["cf-connecting-ip"];
  delete forwardHeaders["cf-ipcountry"];
  delete forwardHeaders["cf-ray"];
  delete forwardHeaders["cf-visitor"];
  delete forwardHeaders["cf-worker"];
  delete forwardHeaders["true-client-ip"];
  delete forwardHeaders["render-proxy-ttl"];
  delete forwardHeaders["rndr-id"];
  delete forwardHeaders["accept-encoding"];

  try {
    const response = await makeRequestWithDoH(
      targetUrl,
      req.method,
      forwardHeaders,
      ["GET", "HEAD"].includes(req.method) ? null : req.body
    );

    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Expose-Headers", "*");

    Object.entries(response.headers).forEach(([k, v]) => {
      if (!["transfer-encoding", "content-encoding", "connection"].includes(k.toLowerCase())) {
        res.set(k, v);
      }
    });

    res.status(response.status).send(response.body);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(502).json({
      error: "Proxy Error",
      message: err.message,
      cause: err.cause ? err.cause.message : null,
      code: err.cause ? err.cause.code : null,
      target: targetUrl,
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Proxy running on port " + port));
