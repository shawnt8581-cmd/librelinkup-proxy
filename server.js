import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.raw({ type: "*/*" }));

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

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "follow",
    });

    const body = await response.arrayBuffer();
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("Access-Control-Expose-Headers", "*");

    response.headers.forEach((v, k) => {
      if (!["transfer-encoding", "content-encoding"].includes(k.toLowerCase())) {
        res.set(k, v);
      }
    });

    res.status(response.status).send(Buffer.from(body));
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
