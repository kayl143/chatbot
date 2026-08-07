// server.js
// A tiny backend proxy for BAI. This is the ONLY place your Groq API key lives.
// The app/frontend never sees it.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "api.env") });
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const admin = require("firebase-admin");

// ---- CORS allowlist ----
// Only browser-origin requests from domains you list here are allowed.
// Capacitor's WebView typically doesn't send an Origin header at all (so it's
// let through below), but if you test this in a regular browser tab, or once
// you deploy chatbot.html somewhere, add that origin to ALLOWED_ORIGINS in
// api.env as a comma-separated list, e.g.:
//   ALLOWED_ORIGINS=http://localhost:5500,https://your-deployed-domain.com
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Requests with no Origin header (native app shells, curl, server-to-server)
    // are let through here — the requireAuth check below is what actually
    // gates access, this is just an extra layer for browser-based callers.
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`Blocked CORS request from origin: ${origin}`);
    return callback(new Error("Not allowed by CORS"));
  }
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "chatbot.html"));
});

app.get("/chatbot.html", (req, res) => {
  res.sendFile(path.join(__dirname, "chatbot.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.3-70b-versatile is deprecated by Groq (shutdown 2026-08-16).
// Using their recommended replacement instead.
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY. Set it as an environment variable before starting the server.");
  process.exit(1);
}

const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, "firebase-service-account.json");
let requireAuth = async (req, res, next) => next();

if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH))
    });

    requireAuth = async (req, res, next) => {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : null;

      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }

      try {
        req.user = await admin.auth().verifyIdToken(token);
        next();
      } catch (err) {
        return res.status(401).json({ error: "Invalid or expired session" });
      }
    };

    console.log(`Firebase auth enabled using service account at ${SERVICE_ACCOUNT_PATH}.`);
  } catch (err) {
    console.warn(
      `Failed to initialize Firebase Admin with ${SERVICE_ACCOUNT_PATH}. ` +
      "Continuing without auth validation. To enable auth, check the service account JSON file and FIREBASE_SERVICE_ACCOUNT_PATH."
    );
  }
} else {
  console.warn(
    `Firebase service account not found at ${SERVICE_ACCOUNT_PATH}. ` +
    "Running without auth validation. If you want auth, add the file or set FIREBASE_SERVICE_ACCOUNT_PATH."
  );
}

app.post("/chat", requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    const groqMessages = [
      {
        role: "system",
        content: "You are BAI, a friendly and helpful AI chat assistant. Keep responses concise and conversational."
      },
      ...messages
    ];

    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: groqMessages,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Groq error:", errText);
      return res.status(response.status).json({ error: "Groq API request failed" });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Sorry, I had trouble responding.";

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;

// Turns the CORS rejection above into a clean JSON response instead of
// Express's default HTML error page.
app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`BAI backend running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}/ to use the app.`);
});