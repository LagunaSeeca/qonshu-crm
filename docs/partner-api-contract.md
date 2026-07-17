# Qonshu CRM — what we need from the app API

**How it works:** we send you a **partner company** and a **date range**. You return that partner's numbers for that range.

---

## Request

`GET /api/qonshu/partner-stats`

| We send | Example | Notes |
|---|---|---|
| `partner` | `"Acme Towers"` | The partner **company name** (agreed: match by name, not id). We enter the name manually on our side. |
| `date_from` | `2026-07-01` | Start of the range (inclusive). |
| `date_to` | `2026-07-31` | End of the range (inclusive). |

> **Names must be stable and exact.** Since we match on the company name, treat it as a key — don't rename a partner without telling us. Match case-insensitively and ignore extra spaces. Unknown name → return `404` (so a mismatch is visible instead of silently showing zeros).

---

## Response — what you return

### A. Users

| Field | Type | Meaning |
|---|---|---|
| `total_users` | number | All app users of this partner. |
| `active_users` | number | Users currently active in your system. |
| `engaged_users` | number | Users who made **at least one payment** in the date range. |
| `total_debt` | number | Total money owed by this partner's users right now. |

### B. Installations

| Field | Type | Meaning |
|---|---|---|
| `total_installations` | number | How many users installed the app. |
| `ios_installations` | number | Installed on iOS. |
| `android_installations` | number | Installed on Android. |
| `logged_in_users` | number | Number of users who **have an app token** — installed *and* logged in (proves real usage). Count only; we don't need token values. |

### C. Payments in the date range

| Field | Type | Meaning |
|---|---|---|
| `total_payments_count` | number | How many payments were made. |
| `total_payments_amount` | number | Total money paid. |
| `amount_by_card` | number | Of that total, paid by card. |
| `amount_by_manual` | number | Of that total, recorded manually. |
| `amount_by_cash` | number | Of that total, paid in cash. |
| `utility_payments_count` | number | How many utility payments. |
| `utility_payments_amount` | number | Total utility amount. |
| `apartment_payments_amount` | number | Total for apartments. |
| `parking_payments_amount` | number | Total for parking. |
| `non_residential_payments_amount` | number | Total for non-residential units. |

> The four category amounts (utility / apartment / parking / non-residential) should add up to `total_payments_amount`. Same for the three method amounts (card / manual / cash).

### D. Payments list

The individual payments in that date range, so we can show the transactions table:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Your id for the payment. |
| `user_id` | string | Who paid. |
| `user_name` | string | Their name (or a label). |
| `date` | datetime | When the payment happened. |
| `amount` | number | How much. |
| `method` | `CARD` / `MANUAL` / `CASH` | How they paid. |
| `category` | `APARTMENT` / `PARKING` / `NON_RESIDENTIAL` / `UTILITY` | What they paid for. |

---

## Full example

**Request**
```
GET /api/qonshu/partner-stats?partner=Acme+Towers&date_from=2026-07-01&date_to=2026-07-31
```

**Response**
```json
{
  "partner": "Acme Towers",
  "date_from": "2026-07-01",
  "date_to": "2026-07-31",

  "total_users": 1342,
  "active_users": 1180,
  "engaged_users": 640,
  "total_debt": 18420.75,

  "total_installations": 1200,
  "ios_installations": 520,
  "android_installations": 680,
  "logged_in_users": 900,

  "total_payments_count": 3120,
  "total_payments_amount": 154300.50,
  "amount_by_card": 120400.00,
  "amount_by_manual": 21900.50,
  "amount_by_cash": 12000.00,

  "utility_payments_count": 810,
  "utility_payments_amount": 39200.00,
  "apartment_payments_amount": 82100.50,
  "parking_payments_amount": 21000.00,
  "non_residential_payments_amount": 12000.00,

  "payments": [
    {
      "id": "pay_558210",
      "user_id": "usr_10293",
      "user_name": "Aysel Mammadova",
      "date": "2026-07-14T09:21:00Z",
      "amount": 149.90,
      "method": "CARD",
      "category": "UTILITY"
    }
  ]
}
```

---

## Format notes

- Dates: ISO format — `2026-07-14T09:21:00Z` for times, `2026-07-01` for the range.
- Money: number with 2 decimals — `149.90`. Always positive (no refunds / negative amounts).
- **Cancelled payments: exclude them.** Cancellations are handled on your side — a cancelled payment must not appear in `payments` or count toward any total.
- No data for the range → same structure with `0`s and an empty `payments` list (not an error).
- Unknown partner name → `404`.
- If the `payments` list is very long, paginate it — but keep the totals above complete for the whole range.
- We call this repeatedly and always use the latest response, so cancellations/corrections on your side flow into the CRM automatically. Please keep it read-only and safe to call often.

## Agreed decisions

| Question | Decision |
|---|---|
| Payment methods | **Confirmed** — CARD, MANUAL, CASH |
| Payment categories | **Confirmed** — APARTMENT, PARKING, NON_RESIDENTIAL, UTILITY |
| Logged-in users | **Yes** — count of users holding an app token |
| Refunds | **None exist** — no negative amounts |
| Cancelled payments | Handled on your side; excluded from the response. Our side updates automatically on the next call. |
| Partner identifier | **Company name** (no id); entered manually on our side — keep names stable and exact |

## Still needed from you

1. **Base URL** (staging + production) and how we **authenticate** (e.g. a token in a header).
2. The **exact list of partner company names** as they appear in your system, so we enter them without typos.
3. A **sample response** from staging for one real partner, to validate against real data before go-live.
