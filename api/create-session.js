// =============================================================
// Tabby Checkout Session Creator — Vercel Serverless Function
// =============================================================
// This function receives customer data from your GHL landing page,
// creates a Tabby checkout session, and returns the redirect URL.
//
// Deploy to Vercel (free) and paste the URL into your GHL page.
// =============================================================

export default async function handler(req, res) {
  // ---- CORS: Allow your GHL domain to call this endpoint ----
  res.setHeader("Access-Control-Allow-Origin", "*"); // Replace * with your GHL domain in production
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---- Configuration (use environment variables in Vercel) ----
  const TABBY_SECRET_KEY = process.env.TABBY_SECRET_KEY;
  const TABBY_PUBLIC_KEY = process.env.TABBY_PUBLIC_KEY;
  const TABBY_MERCHANT_CODE = process.env.TABBY_MERCHANT_CODE;
  const SUCCESS_URL = process.env.SUCCESS_URL || "https://your-ghl-site.com/thank-you";
  const FAILURE_URL = process.env.FAILURE_URL || "https://your-ghl-site.com/payment-failed";
  const CANCEL_URL = process.env.CANCEL_URL || "https://your-ghl-site.com/payment-cancelled";

  if (!TABBY_SECRET_KEY || !TABBY_MERCHANT_CODE) {
    return res.status(500).json({ error: "Server misconfigured: missing Tabby keys" });
  }

  try {
    // ---- Extract customer data from the request ----
    const {
      name = "Customer",
      email = "",
      phone = "",
      amount = "0.00",
      description = "Purchase",
      reference_id = `ORD-${Date.now()}`,
      item_title = "Product",
      item_category = "General",
    } = req.body;

    // ---- Basic validation ----
    if (!phone || !amount || parseFloat(amount) <= 0) {
      return res.status(400).json({
        error: "Missing required fields: phone and amount are required.",
      });
    }

    // ---- Build the Tabby session payload ----
    const payload = {
      payment: {
        amount: parseFloat(amount).toFixed(2),
        currency: "AED",
        description: description,
        buyer: {
          name: name,
          email: email,
          phone: phone,
        },
        shipping_address: {
          city: "Dubai",
          address: "N/A",
          zip: "00000",
        },
        order: {
          reference_id: reference_id,
          items: [
            {
              title: item_title,
              quantity: 1,
              unit_price: parseFloat(amount).toFixed(2),
              reference_id: "ITEM-001",
              category: item_category,
            },
          ],
        },
      },
      lang: "en",
      merchant_code: TABBY_MERCHANT_CODE,
      merchant_urls: {
        success: SUCCESS_URL,
        failure: FAILURE_URL,
        cancel: CANCEL_URL,
      },
    };

    // ---- Call Tabby API to create the session ----
    const tabbyResponse = await fetch("https://api.tabby.ai/api/v2/checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TABBY_PUBLIC_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const tabbyData = await tabbyResponse.json();

    // ---- Handle Tabby response ----
    if (tabbyData.status === "created") {
      // Session created successfully
      // Find the "installments" product and get the web_url
      const installments = tabbyData.configuration?.available_products?.installments?.[0];
      const webUrl = installments?.web_url || tabbyData.configuration?.available_products?.installments?.[0]?.web_url;

      if (webUrl) {
        return res.status(200).json({
          success: true,
          redirect_url: webUrl,
          payment_id: tabbyData.payment?.id,
          session_id: tabbyData.id,
        });
      } else {
        return res.status(200).json({
          success: false,
          error: "Session created but no redirect URL found. Check Tabby dashboard.",
          tabby_response: tabbyData,
        });
      }
    } else if (tabbyData.status === "rejected") {
      return res.status(200).json({
        success: false,
        error: "Tabby was unable to approve this purchase. The customer may need to use an alternative payment method.",
        rejection_reason: tabbyData.configuration?.products?.installments?.[0]?.rejection_reason || "unknown",
      });
    } else {
      return res.status(200).json({
        success: false,
        error: "Unexpected response from Tabby.",
        tabby_response: tabbyData,
      });
    }
  } catch (error) {
    console.error("Tabby session creation error:", error);
    return res.status(500).json({
      error: "Internal server error while creating Tabby session.",
      details: error.message,
    });
  }
}
