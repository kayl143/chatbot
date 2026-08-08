// ==========================================================
//  server.js — Express backend for the BAI chatbot
//  Handles: CORS, Firebase auth verification, Groq proxy
// ==========================================================

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// ---- CORS ----
// ALLOWED_ORIGINS is a comma-separated list of allowed browser origins.
// Leave it blank to allow all origins (fine for testing, tighten before prod).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
  })
);

// ---- Firebase Admin authentication ----
const SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  path.join(__dirname, "firebase-service-account.json");

const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

let requireAuth = async (req, res, next) => next(); // no-op fallback if Firebase isn't configured

try {
  let serviceAccount;

  // For Render: load Firebase credentials from environment variable
  if (FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  // For local development: optionally load the JSON file
  else if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    serviceAccount = require(SERVICE_ACCOUNT_PATH);
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
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

    console.log("Firebase authentication enabled.");
  } else {
    console.warn("Firebase service account not found. Authentication is disabled.");
  }
} catch (err) {
  console.error("Failed to initialize Firebase Admin:", err);
}

// ---- Groq chat endpoint ----
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

app.post("/chat", requireAuth, async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "Server is missing GROQ_API_KEY" });
    }

    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Request must include a non-empty 'messages' array" });
    }

    // Fixed identity so the model answers "what's your name / who made you"
    // consistently, regardless of what the underlying model would otherwise say.
    const systemPrompt = {
      role: "system",
      content:
        "Your name is BAI, which stands for Buddy Artificial Intelligence. " +
        "If anyone asks what your name is, or what BAI stands for, answer with " +
        "exactly that. If anyone asks who made you, created you, or who your " +
        "developer/author is, answer that you were made by Kylle. Keep these " +
        "answers short and natural — don't over-explain unless asked to.",
    };

    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [systemPrompt, ...messages],
      }),
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      console.error("Groq API error:", groqResponse.status, errText);
      return res.status(502).json({ error: "Upstream chat provider error" });
    }

    const data = await groqResponse.json();
    const reply = data.choices?.[0]?.message?.content ?? "Sorry, I didn't get a response.";

    res.json({ reply });
  } catch (err) {
    console.error("Error in /chat:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---- Health check (handy for Render) ----
app.get("/", (req, res) => {
  res.send("BAI chatbot backend is running.");
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});