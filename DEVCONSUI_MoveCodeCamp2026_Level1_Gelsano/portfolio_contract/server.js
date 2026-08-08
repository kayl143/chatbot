// ---- Firebase Admin authentication ----
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  path.join(__dirname, "firebase-service-account.json");

const FIREBASE_SERVICE_ACCOUNT_JSON =
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

let requireAuth = async (req, res, next) => next();

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
      credential: admin.credential.cert(serviceAccount)
    });

    requireAuth = async (req, res, next) => {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ")
        ? header.slice(7)
        : null;

      if (!token) {
        return res.status(401).json({
          error: "Missing Authorization header"
        });
      }

      try {
        req.user = await admin.auth().verifyIdToken(token);
        next();
      } catch (err) {
        return res.status(401).json({
          error: "Invalid or expired session"
        });
      }
    };

    console.log("Firebase authentication enabled.");
  } else {
    console.warn(
      "Firebase service account not found. Authentication is disabled."
    );
  }
} catch (err) {
  console.error("Failed to initialize Firebase Admin:", err);
}