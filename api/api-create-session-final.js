// =============================================================
// Unified Checkout Backend — Tabby + Stripe + GHL CRM
// =============================================================
// Handles both payment methods from a single endpoint:
//   payment_method: "tabby"  → Creates Tabby installment session
//   payment_method: "stripe" → Creates Stripe Checkout session
//
// Both paths:
//   1. Create/update GHL contact
//   2. Create payment session
//   3. Add order note to GHL contact
//   4. Return redirect URL
// =============================================================

import Stripe from "stripe";

export default async function handler(req, res) {
  // ---- CORS ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ---- Configuration ----
  const TABBY_SECRET_KEY = process.env.TABBY_SECRET_KEY;
  const TABBY_PUBLIC_KEY = process.env.TABBY_PUBLIC_KEY;
  const TABBY_MERCHANT_CODE = process.env.TABBY_MERCHANT_CODE;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SUCCESS_URL = process.env.SUCCESS_URL || "https://your-site.com/thank-you";
  const FAILURE_URL = process.env.FAILURE_URL || "https://your-site.com/payment-failed";
  const CANCEL_URL = process.env.CANCEL_URL || "https://your-site.com/payment-cancelled";
  const GHL_API_KEY = process.env.GHL_API_KEY;
  const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

  try {
    // ---- Extract customer data ----
    const {
      payment_method = "tabby",
      name = "Customer",
      email = "",
      phone = "",
      amount = "0.00",
      description = "Purchase",
      reference_id = `ORD-${Date.now()}`,
      item_title = "Product",
      item_category = "General",
      address = "",
      city = "Dubai",
      zip = "00000",
      country = "AE",
    } = req.body;

    // ---- Validation ----
    if (!phone || !amount || parseFloat(amount) <= 0) {
      return res.status(400).json({
        error: "Missing required fields: phone and amount are required.",
      });
    }

    if (!email) {
      return res.status(400).json({
        error: "Email is required.",
      });
    }

    // =============================================
    // STEP 1: Create/Update GHL Contact
    // =============================================
    let ghlContactId = null;

    if (GHL_API_KEY && GHL_LOCATION_ID) {
      try {
        const nameParts = name.trim().split(/\s+/);
        const firstName = nameParts[0] || "Customer";
        const lastName = nameParts.slice(1).join(" ") || "";

        const ghlPayload = {
          locationId: GHL_LOCATION_ID,
          firstName: firstName,
          lastName: lastName,
          email: email,
          phone: phone,
          address1: address,
          city: city,
          postalCode: zip,
          country: country,
          source: "Checkout Page",
          tags: ["checkout-started", "ems-suit", `payment-${payment_method}`],
        };

        const ghlResponse = await fetch(
          "https://services.leadconnectorhq.com/contacts/",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${GHL_API_KEY}`,
              "Content-Type": "application/json",
              Version: "2021-07-28",
            },
            body: JSON.stringify(ghlPayload),
          }
        );

        const ghlData = await ghlResponse.json();

        if (ghlData.contact && ghlData.contact.id) {
          ghlContactId = ghlData.contact.id;
          console.log("GHL Contact created/updated:", ghlContactId);
        } else {
          console.warn("GHL contact response:", JSON.stringify(ghlData));
        }
      } catch (ghlError) {
        console.error("GHL contact creation failed:", ghlError.message);
      }
    }

    // =============================================
    // STEP 2: Create Payment Session
    // =============================================

    if (payment_method === "stripe") {
      // ----------- STRIPE CHECKOUT -----------
      if (!STRIPE_SECRET_KEY) {
        return res.status(500).json({ error: "Stripe is not configured." });
      }

      const stripe = new Stripe(STRIPE_SECRET_KEY);

      // Create Stripe Checkout Session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        customer_email: email,
        line_items: [
          {
            price_data: {
              currency: "aed",
              product_data: {
                name: item_title,
                description: description,
              },
              unit_amount: Math.round(parseFloat(amount) * 100), // Stripe uses cents
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: SUCCESS_URL + "?session_id={CHECKOUT_SESSION_ID}&method=stripe",
        cancel_url: CANCEL_URL + "?method=stripe",
        metadata: {
          reference_id: reference_id,
          customer_name: name,
          customer_phone: phone,
          ghl_contact_id: ghlContactId || "",
        },
        shipping_address_collection: {
          allowed_countries: ["AE", "SA", "KW", "BH", "QA", "OM", "EG"],
        },
      });

      // Add note to GHL contact
      if (ghlContactId && GHL_API_KEY) {
        try {
          await fetch(
            `https://services.leadconnectorhq.com/contacts/${ghlContactId}/notes`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                "Content-Type": "application/json",
                Version: "2021-07-28",
              },
              body: JSON.stringify({
                body: `💳 Stripe Checkout Started\n- Product: ${item_title}\n- Amount: ${amount} AED\n- Order Ref: ${reference_id}\n- Stripe Session: ${session.id}\n- Status: Awaiting Payment`,
              }),
            }
          );
        } catch (noteError) {
          console.error("GHL note failed:", noteError.message);
        }
      }

      return res.status(200).json({
        success: true,
        redirect_url: session.url,
        session_id: session.id,
        ghl_contact_id: ghlContactId,
        payment_method: "stripe",
      });

    } else {
      // ----------- TABBY CHECKOUT -----------
      if (!TABBY_SECRET_KEY || !TABBY_MERCHANT_CODE) {
        return res.status(500).json({ error: "Tabby is not configured." });
      }

      const tabbyPayload = {
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
            city: city,
            address: address || "N/A",
            zip: zip,
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
          success: SUCCESS_URL + "?method=tabby",
          failure: FAILURE_URL + "?method=tabby",
          cancel: CANCEL_URL + "?method=tabby",
        },
      };

      const tabbyResponse = await fetch("https://api.tabby.ai/api/v2/checkout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TABBY_PUBLIC_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(tabbyPayload),
      });

      const tabbyData = await tabbyResponse.json();

      if (tabbyData.status === "created") {
        const installments =
          tabbyData.configuration?.available_products?.installments?.[0];
        const webUrl = installments?.web_url;

        // Add note to GHL contact
        if (ghlContactId && GHL_API_KEY) {
          try {
            await fetch(
              `https://services.leadconnectorhq.com/contacts/${ghlContactId}/notes`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${GHL_API_KEY}`,
                  "Content-Type": "application/json",
                  Version: "2021-07-28",
                },
                body: JSON.stringify({
                  body: `🛒 Tabby Checkout Started\n- Product: ${item_title}\n- Amount: ${amount} AED\n- Order Ref: ${reference_id}\n- Session ID: ${tabbyData.id || "N/A"}\n- Payment ID: ${tabbyData.payment?.id || "N/A"}\n- Status: Awaiting Payment`,
                }),
              }
            );
          } catch (noteError) {
            console.error("GHL note failed:", noteError.message);
          }
        }

        if (webUrl) {
          return res.status(200).json({
            success: true,
            redirect_url: webUrl,
            payment_id: tabbyData.payment?.id,
            session_id: tabbyData.id,
            ghl_contact_id: ghlContactId,
            payment_method: "tabby",
          });
        } else {
          return res.status(200).json({
            success: false,
            error: "Session created but no redirect URL found.",
            tabby_response: tabbyData,
          });
        }
      } else if (tabbyData.status === "rejected") {
        // Tag contact as rejected
        if (ghlContactId && GHL_API_KEY) {
          try {
            await fetch(
              `https://services.leadconnectorhq.com/contacts/${ghlContactId}`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${GHL_API_KEY}`,
                  "Content-Type": "application/json",
                  Version: "2021-07-28",
                },
                body: JSON.stringify({
                  tags: ["checkout-started", "ems-suit", "tabby-rejected"],
                }),
              }
            );
          } catch (tagError) {
            console.error("GHL tag update failed:", tagError.message);
          }
        }

        return res.status(200).json({
          success: false,
          error:
            "Tabby was unable to approve this purchase. Please try paying with a card instead.",
          rejection_reason:
            tabbyData.configuration?.products?.installments?.[0]
              ?.rejection_reason || "unknown",
        });
      } else {
        return res.status(200).json({
          success: false,
          error: "Unexpected response from Tabby.",
          tabby_response: tabbyData,
        });
      }
    }
  } catch (error) {
    console.error("Checkout error:", error);
    return res.status(500).json({
      error: "Internal server error.",
      details: error.message,
    });
  }
}
