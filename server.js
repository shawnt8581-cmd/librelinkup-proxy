import express from "express";
import cors from "cors";
import https from "node:https";
import http from "node:http";
import dns from "node:dns";
import { URL } from "node:url";

const app = express();
app.use(cors());
app.use(express.raw({ type: "*/*" }));

// Use Cloudflare's DNS (1.1.1.1) and Google's (8.8.8.8)
const resolver = new dns.Resolver();
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

function customLookup(hostname, options, callback) {
  // First try A records
  resolver.resolve4(hostname, (err, addresses) => {
    if (!err && addresses && addresses.length > 0) {
      if (options.all) {
        callback(null, addresses.map((addr) => ({ address: addr, family: 4 })));
      } else {
        callback(null, addresses[0], 4);
      }
      return;
    }

    // If no A records, try CNAME, then resolve the target
    resolver.resolveCname(hostname, (cerr, cnames) => {
      if (!cerr && cnames && cnames.length > 0) {
        // Recursively resolve the CNAME target
        customLookup(cnames[0], options, callback);
        return;
      }

      // Try AAAA records as fallback
      resolver.resolve6(hostname, (verr, v6addresses) => {
        if (!verr && v6addresses && v6addresses.length > 0) {
          if (options.all) {
            callback(null, v6addresses.map((addr) => ({ address: addr, family: 6 })));
          } else {
            callback(null, v6addresses[0], 6);
          }
          return;
        }

        // Last resort: try resolveAny
        resolver.resolveAny(hostname, (aerr, records) => {
          if (!aerr && records && records.length > 0) {
            for (const r of records) {
              if (r.type === "A" && r.address) {
                callback(null, r.address, 4);
                return;
              }
              if (r.type === "CNAME" && r.value) {
                customLookup(r.value, options, callback);
                return;
              }
              if (r.type === "AAAA" && r.address) {
                callback(null, r.address, 6);
                return;
              }
            }
          }

          // Final fallback: use the system default lookup
          dns.lookup(hostname, options, callback);
        });
      });
    });
  });
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
      headers: headers,
      lookup: customLookup,
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
    const response = await makeRequest(
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
