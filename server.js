import express from "express";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();
const app = express();
app.use(express.json());

// ===== Firebase Admin Initialization =====
try {
  if (!admin.apps.length) {
    const serviceAccount = {
      type: process.env.FIREBASE_TYPE,
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: process.env.FIREBASE_AUTH_URI,
      token_uri: process.env.FIREBASE_TOKEN_URI,
      auth_provider_x509_cert_url:
        process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
      client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
      universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL,
    });
    console.log("✅ Firebase Admin initialized");
  }
} catch (err) {
  console.error("❌ Firebase initialization failed:", err.message);
}

const rtdb = admin.database();

// ===== Helpers =====
const getReqTime = () => {
  const d = new Date();
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0") +
    String(d.getUTCHours()).padStart(2, "0") +
    String(d.getUTCMinutes()).padStart(2, "0") +
    String(d.getUTCSeconds()).padStart(2, "0")
  );
};

const activeChecks = new Set(); // To prevent duplicate polling per machine

// ===== ABA Payload Builder =====
const generateABAPayload = ({
  tran_id,
  amount,
  items = [],
  req_time,
  callbackBase64 = "",
  return_params = "",
}) => {
  const first_name = "thuch";
  const last_name = "sopanha";
  const email = "thuchsopanha789@gmail.com";
  const phone = "+855 61 666 355";
  const purchase_type = "purchase";
  const payment_option = "abapay_khqr";
  const lifetime = 3;
  const qr_image_template = "template2_color";
  const itemsBase64 = Buffer.from(JSON.stringify(items)).toString("base64");

  const b4hash =
    req_time +
    process.env.ABA_PAYWAY_MERCHANT_ID +
    tran_id +
    amount +
    itemsBase64 +
    first_name +
    last_name +
    email +
    phone +
    purchase_type +
    payment_option +
    callbackBase64 +
    "KHR" +
    return_params +
    lifetime +
    qr_image_template;

  const hash = crypto
    .createHmac("sha512", process.env.ABA_PAYWAY_API_KEY)
    .update(b4hash)
    .digest("base64");

  return {
    req_time,
    merchant_id: process.env.ABA_PAYWAY_MERCHANT_ID,
    tran_id,
    first_name,
    last_name,
    email,
    phone,
    amount,
    currency: "KHR",
    purchase_type,
    payment_option,
    items: itemsBase64,
    callback_url: callbackBase64,
    return_params,
    lifetime,
    qr_image_template,
    hash,
  };
};

// ===== ABA Check Transaction Polling =====
async function checkTransactionUntilApproved(machine, tran_id) {
  // prevent duplicate polling for same machine
  if (activeChecks.has(machine)) return;
  activeChecks.add(machine);

  const intervalMs = 10000; // check every 10s
  const maxWaitMs = 3 * 60 * 1000; // 3 minutes for all
  const startTime = Date.now();

  // wait 3s before first poll (ensure ABA has record)
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`🕐 Start polling for ${machine}, tran_id=${tran_id}`);

  const checkInterval = setInterval(async () => {
    try {
      // === Step 1: Build payload ===
      const req_time = getReqTime();
      const payload = {
        req_time,
        merchant_id: process.env.ABA_PAYWAY_MERCHANT_ID,
        tran_id,
      };

      const hashString =
        payload.req_time + payload.merchant_id + payload.tran_id;
      payload.hash = crypto
        .createHmac("sha512", process.env.ABA_PAYWAY_API_KEY)
        .update(hashString)
        .digest("base64");

      console.log(`🔹 [${machine}] Check payload:`, payload);

      // === Step 2: Call ABA check API ===
      const { data: result } = await axios.post(
        process.env.ABA_PAYWAY_CHECK_API_URL,
        payload,
        { headers: { "Content-Type": "application/json" } }
      );

      console.log(`🔍 [${machine}] Check result:`, result);
      await rtdb.ref(`Vending-System/${machine}/status`).set({
        payment_status: result.data.payment_status,
        tran_id,
        amount: result.data.total_amount || 0,
        apv: result.data.apv || null,
        currency: result.data.payment_currency || "KHR",
        timestamp: getReqTime(),
      });

      // === Step 3: Interpret ABA result ===
      const statusCode = result?.status?.code;
      const paymentStatus = result?.data?.payment_status;

      // ✅ APPROVED condition
      if (statusCode === "00" && paymentStatus === "APPROVED") {
        clearInterval(checkInterval);
        activeChecks.delete(machine);

        console.log(`✅ Payment approved for ${machine} (${tran_id})`);

        await rtdb.ref(`Vending-System/${machine}/status`).set({
          payment_status: result.data.payment_status || "NO DATA",
          payment_amount: result.data.payment_amount || 0,
          tran_id,
          amount: result.data.total_amount || 0,
          apv: result.data.apv || null,
          currency: result.data.payment_currency || "KHR",
          timestamp: getReqTime(),
        });

        // optional: notify or trigger dispense
        // await rtdb.ref(`Vending-System/${machine}/command`).set("DISPENSE");
        return;
      }

      // ⏰ Timeout after 3 min
      if (Date.now() - startTime >= maxWaitMs) {
        clearInterval(checkInterval);
        activeChecks.delete(machine);
        console.log(`⏰ Timeout for ${machine} (${tran_id})`);

        await rtdb.ref(`Vending-System/${machine}/status`).set({
          payment_status: "expired",
          tran_id,
          timestamp: getReqTime(),
        });
      }
    } catch (err) {
      console.error(
        `❌ Error checking transaction ${tran_id}:`,
        err.response?.data || err.message
      );
    }
  }, intervalMs);
}

// ===== Transaction Listener =====
function listenNewTransactions() {
  const tranRef = rtdb.ref("Vending-System");

  // Keep track of currently processing transactions
  const activeRequests = new Map(); // key: machineId, value: requestTime

  tranRef.on("value", async (snapshot) => {
    const allMachines = snapshot.val();
    if (!allMachines) return;

    for (const [machine, data] of Object.entries(allMachines)) {
      if (!data?.request) continue;

      const reqTime = data.request.time;
      const amount = data.request.amount?.toString();
      const slot = data.request.location;

      // Skip if already processed or currently processing
      const alreadyProcessing = activeRequests.get(machine);
      const alreadyResponded =
        data.response && data.response.requestTime === reqTime;

      if (alreadyProcessing === reqTime || alreadyResponded) continue;

      // Lock this request
      activeRequests.set(machine, reqTime);

      const req_time = getReqTime();
      const tran_id = "tran-" + req_time;
      const callbackUrl = `${process.env.SERVER_URL}/Vending-System/${machine}/callback.json`;
      const callbackBase64 = Buffer.from(callbackUrl).toString("base64");
      const return_params = `Machine: ${machine},Amount: ${amount},Slot_Number: ${slot}`;

      console.log(
        `🆕 New transaction for ${machine}: ${slot} value ${amount} KHR`
      );
      console.log(`➡️ Sending to ABA PayWay for ${machine}...`);

      try {
        // Clean previous response/callback
        await Promise.all([
          rtdb.ref(`Vending-System/${machine}/callback`).remove(),
          rtdb.ref(`Vending-System/${machine}/response`).remove(),
          rtdb.ref(`Vending-System/${machine}/status`).remove(),
        ]);

        const payload = generateABAPayload({
          tran_id,
          amount,
          items: data.request.items || [],
          req_time,
          callbackBase64,
          return_params,
        });

        const { data: abaResponse } = await axios.post(
          process.env.ABA_PAYWAY_API_URL,
          payload,
          { headers: { "Content-Type": "application/json" } }
        );

        await rtdb.ref(`Vending-System/${machine}/response`).set({
          qrString: abaResponse.qrString,
          amount: abaResponse.amount,
          timestamp: getReqTime(),
          requestTime: reqTime,
          status: "pending",
        });

        console.log(`✅ ABA payment processed for ${machine}`);

        // Start polling for approval (3 minutes)
        checkTransactionUntilApproved(machine, tran_id, 3 * 60 * 1000);
      } catch (err) {
        console.error(
          `❌ ABA Pay Error for ${machine}:`,
          err.response?.data || err.message
        );
        await rtdb.ref(`Vending-System/${machine}/response`).set({
          error: err.response?.data || err.message,
          requestTime: reqTime,
        });
      } finally {
        // Release lock after 3 min
        setTimeout(() => {
          activeRequests.delete(machine);
        }, 3 * 60 * 1000);
      }
    }
  });
}

listenNewTransactions();

// ===== Health Check =====
app.get("/health", (req, res) => res.send("OK"));

// ===== Error Handling =====
process.on("unhandledRejection", (err) =>
  console.error("Unhandled Rejection:", err)
);
process.on("uncaughtException", (err) =>
  console.error("Uncaught Exception:", err)
);

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
