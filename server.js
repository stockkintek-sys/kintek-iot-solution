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

// ===== ABA Payload Builder =====
const generateABAPayload = ({
  tran_id,
  amount,
  items = [],
  req_time,
  callbackBase64 = "",
  return_params = "",
}) => {
  const first_name = "test";
  const last_name = "ABA";
  const email = "aba@gmail.com";
  const phone = "+85512345678";
  const purchase_type = "purchase";
  const payment_option = "abapay_khqr";
  const lifetime = 30;
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

// ===== Transaction Listener =====
function listenNewTransactions() {
  const tranRef = rtdb.ref("Vending-System");

  tranRef.on("child_added", handleTransaction);
  tranRef.on("child_changed", handleTransaction);

  async function handleTransaction(snapshot) {
    const machine = snapshot.key;
    const data = snapshot.val();

    if (
      data?.request &&
      (!data.response || data.response.requestTime !== data.request.time)
    ) {
      const amount = data.request.amount.toString();
      const locat = data.request.location;
      const req_time = getReqTime();
      const tran_id = "tran-" + req_time;

      const callbackUrl = `${process.env.SERVER_URL}/Vending-System/${machine}/callback.json`;
      const callbackBase64 = Buffer.from(callbackUrl).toString("base64");
      const return_params = `Machine: ${machine},Amount: ${amount},Slot_Number: ${locat}`;

      // console.log(`Callback URL: ${callbackUrl}`);
      // console.log(`Callback Base64: ${callbackBase64}`);
      // console.log(`Return Params: ${return_params}`);
      console.log(
        `🆕 New transaction for ${machine}: ${locat} value ${amount} KHR`
      );

      const payload = generateABAPayload({
        tran_id,
        amount,
        items: data.request.items || [],
        req_time,
        callbackBase64,
        return_params,
      });

      console.log("Payload:", payload);
      // console.log(`Request tran_id ${tran_id}`);
      console.log(`➡️ Sending to ABA PayWay for ${machine}...`);

      try {
        await rtdb.ref(`Vending-System/${machine}/callback`).remove();
        // await rtdb.ref(`Vending-System/${machine}/response`).remove();

        const { data: abaResponse } = await axios.post(
          process.env.ABA_PAYWAY_API_URL,
          payload,
          { headers: { "Content-Type": "application/json" } }
        );

        await rtdb.ref(`Vending-System/${machine}/response`).set({
          qrString: abaResponse.qrString,
          amount: abaResponse.amount,
          timestamp: getReqTime(),
          requestTime: data.request.time,
        });
        console.log(`Response tran_id ${tran_id}`);
        console.log(`✅ ABA payment processed for ${machine}`);
      } catch (err) {
        console.error(
          `❌ ABA Pay Error for ${machine}:`,
          err.response?.data || err.message
        );
        await rtdb.ref(`Vending-System/${machine}/response`).set({
          error: err.response?.data || err.message,
          requestTime: data.request.time,
        });
      }
    }
  }
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




